import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import pinoHttp from "pino-http";
import { v4 as uuidv4 } from "uuid";

import { pool, writeAudit } from "./db.js";
import { signToken, requireAuth, requireRole } from "./auth.js";
import { logger } from "./logger.js";
import { connectEvents, publishTransactionCompleted } from "./events.js";
import { registry, transactionCounter, httpMetricsMiddleware } from "./metrics.js";

const app = express();
const PORT = process.env.PORT || 8080;
const COBOL_ENGINE_URL = process.env.COBOL_ENGINE_URL || "http://localhost:9001";

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(pinoHttp({ logger }));
app.use(httpMetricsMiddleware);

// Global rate limit: blunt protection against brute force / abuse,
// mirrors network-layer controls (firewall/WAF) in front of a mainframe gateway.
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  message: { error: "too many login attempts, try again later" },
});

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress;
}

// ---------------------------------------------------------------------------
// Health & observability
// ---------------------------------------------------------------------------
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "UP", db: "UP" });
  } catch {
    res.status(503).json({ status: "DOWN", db: "DOWN" });
  }
});

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", registry.contentType);
  res.end(await registry.metrics());
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post("/api/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }

  const { rows } = await pool.query(
    "SELECT * FROM app_users WHERE username = $1",
    [username]
  );
  const user = rows[0];
  const ip = clientIp(req);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    await writeAudit({ actor: username, action: "LOGIN_FAILED", ip });
    return res.status(401).json({ error: "invalid credentials" });
  }

  await writeAudit({ actor: username, action: "LOGIN_SUCCESS", ip });
  const token = signToken(user);
  res.json({ token, role: user.role, username: user.username });
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
app.get("/api/accounts", requireAuth, requireRole("TELLER", "AUDITOR"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT account_id, account_number, holder_name, balance_cents, status, updated_at
     FROM accounts ORDER BY account_id`
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Transactions — the core path: gateway -> COBOL engine -> Db2(Postgres),
// then an event is published for the fraud-consumer to score asynchronously.
//
// Idempotency: a client may send an `Idempotency-Key` header. If a request
// with that key already completed, we return the SAME stored response
// instead of re-running the transaction — this is what stops a dropped
// network response + client retry from double-posting money, the same
// problem CICS/IMS transaction backout solves on a real mainframe.
// ---------------------------------------------------------------------------
app.post("/api/transactions", requireAuth, requireRole("TELLER"), async (req, res) => {
  const { txnType, fromAccountId, toAccountId, amountCents } = req.body;
  const ip = clientIp(req);
  const idempotencyKey = req.headers["idempotency-key"];

  if (!["DEPOSIT", "WITHDRAW", "TRANSFER"].includes(txnType)) {
    return res.status(400).json({ error: "invalid txnType" });
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: "amountCents must be a positive integer" });
  }

  if (idempotencyKey) {
    const cached = await pool.query(
      "SELECT response_status, response_body FROM idempotency_keys WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    if (cached.rows.length > 0) {
      logger.info({ idempotencyKey }, "idempotent replay, returning cached response");
      return res.status(cached.rows[0].response_status).json(cached.rows[0].response_body);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let fromAccount = null;
    let toAccount = null;

    if (txnType !== "DEPOSIT") {
      const r = await client.query(
        "SELECT * FROM accounts WHERE account_id = $1 FOR UPDATE",
        [fromAccountId]
      );
      fromAccount = r.rows[0];
      if (!fromAccount) throw new Error("fromAccountId not found");
    }
    if (txnType !== "WITHDRAW") {
      const r = await client.query(
        "SELECT * FROM accounts WHERE account_id = $1 FOR UPDATE",
        [toAccountId]
      );
      toAccount = r.rows[0];
      if (!toAccount) throw new Error("toAccountId not found");
    }

    // Call the COBOL transaction engine (via the load-balanced cobol-lb
    // endpoint) — this is the business-rule authority (mirrors an IMS TM
    // program), not the gateway itself.
    const engineResp = await fetch(`${COBOL_ENGINE_URL}/txn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txnType,
        fromBalance: fromAccount ? fromAccount.balance_cents : 0,
        toBalance: toAccount ? toAccount.balance_cents : 0,
        amount: amountCents,
      }),
    });
    const decision = await engineResp.json();

    const txnRef = uuidv4();

    async function cacheAndRespond(status, body) {
      if (idempotencyKey) {
        await client.query(
          `INSERT INTO idempotency_keys (idempotency_key, response_status, response_body)
           VALUES ($1, $2, $3)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [idempotencyKey, status, JSON.stringify(body)]
        );
      }
      res.status(status).json(body);
    }

    if (decision.result !== "POSTED") {
      await client.query(
        `INSERT INTO transactions
           (txn_ref, txn_type, from_account_id, to_account_id, amount_cents, status, reject_reason, cobol_engine_trace)
         VALUES ($1,$2,$3,$4,$5,'REJECTED',$6,$7)`,
        [txnRef, txnType, fromAccountId ?? null, toAccountId ?? null, amountCents, decision.reason, decision.trace]
      );
      await client.query("COMMIT");
      transactionCounter.inc({ txn_type: txnType, status: "REJECTED" });
      await writeAudit({
        actor: req.user.username,
        action: "TXN_REJECTED",
        target: txnRef,
        detail: { txnType, amountCents, reason: decision.reason },
        ip,
      });
      return cacheAndRespond(422, { status: "REJECTED", reason: decision.reason, txnRef });
    }

    if (fromAccount) {
      await client.query(
        "UPDATE accounts SET balance_cents = $1, updated_at = now() WHERE account_id = $2",
        [decision.newFromBalance, fromAccount.account_id]
      );
    }
    if (toAccount) {
      await client.query(
        "UPDATE accounts SET balance_cents = $1, updated_at = now() WHERE account_id = $2",
        [decision.newToBalance, toAccount.account_id]
      );
    }

    const insertResult = await client.query(
      `INSERT INTO transactions
         (txn_ref, txn_type, from_account_id, to_account_id, amount_cents, status, cobol_engine_trace)
       VALUES ($1,$2,$3,$4,$5,'POSTED',$6)
       RETURNING transaction_id`,
      [txnRef, txnType, fromAccountId ?? null, toAccountId ?? null, amountCents, decision.trace]
    );
    const transactionId = insertResult.rows[0].transaction_id;

    await client.query("COMMIT");
    transactionCounter.inc({ txn_type: txnType, status: "POSTED" });

    // Published AFTER commit, outside the DB transaction: the event is
    // best-effort and must never risk rolling back money that already moved.
    publishTransactionCompleted({
      transactionId,
      primaryAccountId: (toAccount ?? fromAccount)?.account_id,
      amountCents,
      txnType,
      origin: "TELLER",
    });

    await writeAudit({
      actor: req.user.username,
      action: "TXN_POSTED",
      target: txnRef,
      detail: { txnType, amountCents },
      ip,
    });

    await cacheAndRespond(201, { status: "POSTED", txnRef });
  } catch (err) {
    await client.query("ROLLBACK");
    await writeAudit({
      actor: req.user?.username ?? "unknown",
      action: "TXN_ERROR",
      detail: { message: err.message },
      ip,
    });
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/api/transactions", requireAuth, requireRole("TELLER", "AUDITOR"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM transactions ORDER BY created_at DESC LIMIT 100`
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Audit log — auditor-only read access (least privilege)
// ---------------------------------------------------------------------------
app.get("/api/audit", requireAuth, requireRole("AUDITOR"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200`
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Fraud alerts — written asynchronously by fraud-consumer, read here.
// ---------------------------------------------------------------------------
app.get("/api/fraud-alerts", requireAuth, requireRole("AUDITOR"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT fa.*, a.account_number, a.holder_name
     FROM fraud_alerts fa JOIN accounts a ON a.account_id = fa.account_id
     ORDER BY fa.created_at DESC LIMIT 100`
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Batch run history — visibility into the nightly COBOL batch job.
// ---------------------------------------------------------------------------
app.get("/api/batch-runs", requireAuth, requireRole("AUDITOR"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM batch_runs ORDER BY started_at DESC LIMIT 20`
  );
  res.json(rows);
});

connectEvents();

app.listen(PORT, () => {
  logger.info(`gateway listening on :${PORT}`);
});
