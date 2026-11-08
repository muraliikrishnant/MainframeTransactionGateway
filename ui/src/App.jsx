import React, { useEffect, useState } from "react";
import {
  login,
  getAccounts,
  getTransactions,
  postTransaction,
  getAudit,
  getFraudAlerts,
  getBatchRuns,
} from "./api.js";

function centsToDollars(cents) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("teller1");
  const [password, setPassword] = useState("teller123");
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    try {
      const data = await login(username, password);
      onLogin(data);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Mainframe Transaction Gateway</h1>
        <p className="subtitle">Hybrid-cloud bridge over an IMS/COBOL-style core banking engine</p>
        <form onSubmit={submit}>
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <button type="submit">Sign In</button>
        </form>
        <div className="hint">
          Demo users: <code>teller1 / teller123</code> or <code>auditor1 / auditor123</code>
        </div>
      </div>
    </div>
  );
}

function SecurityPanel() {
  return (
    <div className="panel security-panel">
      <h3>Security &amp; Architecture Posture</h3>
      <ul>
        <li>✅ TLS termination at gateway edge</li>
        <li>✅ JWT bearer auth, 30-minute token expiry</li>
        <li>✅ Role-based access control (TELLER / AUDITOR), least privilege</li>
        <li>✅ Column-level encryption at rest (card numbers, pgcrypto)</li>
        <li>✅ Append-only audit log (DB trigger blocks UPDATE/DELETE)</li>
        <li>✅ Idempotency keys prevent duplicate transaction posting on retry</li>
        <li>✅ Rate limiting on login and global API traffic</li>
        <li>✅ Business rules isolated in COBOL engine (no logic duplication)</li>
        <li>✅ Two load-balanced COBOL engine replicas (Sysplex-style failover)</li>
        <li>✅ Async fraud scoring decoupled via message queue (never blocks a teller)</li>
        <li>✅ Prometheus metrics at /metrics, structured JSON logs</li>
      </ul>
    </div>
  );
}

function FraudAlertsPanel({ token }) {
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    getFraudAlerts(token).then(setAlerts).catch(() => {});
    const id = setInterval(() => getFraudAlerts(token).then(setAlerts).catch(() => {}), 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="panel wide">
      <h3>Fraud Alerts <span className="hint-inline">(scored asynchronously via RabbitMQ consumer)</span></h3>
      <table>
        <thead>
          <tr><th>Account</th><th>Holder</th><th>Reason</th><th>Score</th><th>When</th></tr>
        </thead>
        <tbody>
          {alerts.length === 0 && (
            <tr><td colSpan="5" className="hint-inline">No alerts yet</td></tr>
          )}
          {alerts.map((a) => (
            <tr key={a.alert_id}>
              <td>{a.account_number}</td>
              <td>{a.holder_name}</td>
              <td>{a.reason}</td>
              <td>{Number(a.score).toFixed(2)}</td>
              <td>{new Date(a.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BatchRunsPanel({ token }) {
  const [runs, setRuns] = useState([]);

  useEffect(() => {
    getBatchRuns(token).then(setRuns).catch(() => {});
  }, []);

  return (
    <div className="panel wide">
      <h3>Batch Job History <span className="hint-inline">(nightly COBOL interest accrual, JCL-window analog)</span></h3>
      <table>
        <thead>
          <tr><th>Job</th><th>Status</th><th>Accounts</th><th>Interest Accrued</th><th>Started</th></tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.batch_run_id}>
              <td>{r.job_name}</td>
              <td className={r.status === "SUCCESS" ? "ok" : r.status === "FAILED" ? "bad" : ""}>{r.status}</td>
              <td>{r.accounts_processed}</td>
              <td>{centsToDollars(r.total_interest_cents)}</td>
              <td>{new Date(r.started_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TellerView({ token }) {
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [form, setForm] = useState({ txnType: "TRANSFER", fromAccountId: "", toAccountId: "", amount: "" });
  const [message, setMessage] = useState(null);

  async function refresh() {
    setAccounts(await getAccounts(token));
    setTransactions(await getTransactions(token));
  }

  useEffect(() => {
    refresh().catch((e) => setMessage(e.message));
  }, []);

  async function submitTxn(e) {
    e.preventDefault();
    setMessage(null);
    try {
      const payload = {
        txnType: form.txnType,
        amountCents: Math.round(parseFloat(form.amount) * 100),
        fromAccountId: form.fromAccountId ? Number(form.fromAccountId) : undefined,
        toAccountId: form.toAccountId ? Number(form.toAccountId) : undefined,
      };
      const result = await postTransaction(token, payload);
      setMessage(`Transaction ${result.status}: ${result.txnRef}`);
      await refresh();
    } catch (err) {
      setMessage(`Error: ${err.message}`);
    }
  }

  return (
    <div className="grid">
      <div className="panel">
        <h3>Accounts</h3>
        <table>
          <thead>
            <tr><th>ID</th><th>Account #</th><th>Holder</th><th>Balance</th><th>Status</th></tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.account_id}>
                <td>{a.account_id}</td>
                <td>{a.account_number}</td>
                <td>{a.holder_name}</td>
                <td>{centsToDollars(a.balance_cents)}</td>
                <td>{a.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>New Transaction</h3>
        <form onSubmit={submitTxn} className="txn-form">
          <label>Type</label>
          <select value={form.txnType} onChange={(e) => setForm({ ...form, txnType: e.target.value })}>
            <option value="DEPOSIT">DEPOSIT</option>
            <option value="WITHDRAW">WITHDRAW</option>
            <option value="TRANSFER">TRANSFER</option>
          </select>

          {form.txnType !== "DEPOSIT" && (
            <>
              <label>From Account</label>
              <select
                value={form.fromAccountId}
                onChange={(e) => setForm({ ...form, fromAccountId: e.target.value })}
              >
                <option value="">Select account…</option>
                {accounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    {a.account_number} — {a.holder_name} ({centsToDollars(a.balance_cents)})
                  </option>
                ))}
              </select>
            </>
          )}
          {form.txnType !== "WITHDRAW" && (
            <>
              <label>To Account</label>
              <select
                value={form.toAccountId}
                onChange={(e) => setForm({ ...form, toAccountId: e.target.value })}
              >
                <option value="">Select account…</option>
                {accounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    {a.account_number} — {a.holder_name} ({centsToDollars(a.balance_cents)})
                  </option>
                ))}
              </select>
            </>
          )}
          <label>Amount (USD)</label>
          <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />

          <button type="submit">Post Transaction</button>
        </form>
        {message && <div className="message">{message}</div>}
      </div>

      <div className="panel wide">
        <h3>Recent Transactions</h3>
        <table>
          <thead>
            <tr><th>Ref</th><th>Type</th><th>From</th><th>To</th><th>Amount</th><th>Status</th><th>When</th></tr>
          </thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.transaction_id}>
                <td className="mono">{t.txn_ref.slice(0, 8)}</td>
                <td>{t.txn_type}</td>
                <td>{t.from_account_id ?? "—"}</td>
                <td>{t.to_account_id ?? "—"}</td>
                <td>{centsToDollars(t.amount_cents)}</td>
                <td className={t.status === "POSTED" ? "ok" : "bad"}>{t.status}</td>
                <td>{new Date(t.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SecurityPanel />
    </div>
  );
}

function AuditorView({ token }) {
  const [audit, setAudit] = useState([]);
  const [transactions, setTransactions] = useState([]);

  useEffect(() => {
    getAudit(token).then(setAudit).catch(() => {});
    getTransactions(token).then(setTransactions).catch(() => {});
  }, []);

  return (
    <div className="grid">
      <div className="panel wide">
        <h3>Audit Log</h3>
        <table>
          <thead>
            <tr><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th><th>When</th></tr>
          </thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.audit_id}>
                <td>{a.actor}</td>
                <td>{a.action}</td>
                <td className="mono">{a.target ?? "—"}</td>
                <td className="mono small">{a.detail ? JSON.stringify(a.detail) : "—"}</td>
                <td>{a.ip_address}</td>
                <td>{new Date(a.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <FraudAlertsPanel token={token} />
      <BatchRunsPanel token={token} />
      <div className="panel wide">
        <h3>All Transactions</h3>
        <table>
          <thead>
            <tr><th>Ref</th><th>Type</th><th>Status</th><th>Amount</th><th>When</th></tr>
          </thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.transaction_id}>
                <td className="mono">{t.txn_ref.slice(0, 8)}</td>
                <td>{t.txn_type}</td>
                <td className={t.status === "POSTED" ? "ok" : "bad"}>{t.status}</td>
                <td>{centsToDollars(t.amount_cents)}</td>
                <td>{new Date(t.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SecurityPanel />
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null);

  if (!session) {
    return <LoginScreen onLogin={setSession} />;
  }

  return (
    <div className="app">
      <header>
        <h2>Mainframe Transaction Gateway</h2>
        <div className="session-info">
          {session.username} · {session.role}
          <button className="link" onClick={() => setSession(null)}>Sign out</button>
        </div>
      </header>
      {session.role === "TELLER" ? (
        <TellerView token={session.token} />
      ) : (
        <AuditorView token={session.token} />
      )}
    </div>
  );
}
