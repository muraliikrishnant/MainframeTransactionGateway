# Security Design

Mapped to the "Networking and Security" preferred skill in the GM posting, and to
how real mainframe shops think about defense in depth.

## 1. Authentication & session management
- JWT bearer tokens, 30-minute expiry, signed with a server-side secret
  (`gateway/src/auth.js`). Short-lived tokens limit the blast radius of a stolen token.
- Passwords stored with **bcrypt** (cost factor 12), never plaintext or reversibly
  encrypted — matches how RACF/ACF2 never store recoverable passwords either.

## 2. Authorization (RBAC, least privilege)
- Two roles: `TELLER` (can view accounts, post transactions) and `AUDITOR`
  (read-only on transactions and the audit log, cannot move money).
- Enforced centrally via `requireRole()` middleware on each route — not scattered
  `if` checks in handlers, so the full access matrix is auditable at a glance.
- Mirrors Db2's `GRANT SELECT/INSERT ON ... TO ROLE` model and RACF resource profiles.

## 3. Encryption
- **In transit**: gateway sits behind TLS termination (Helmet sets secure headers;
  in production this stack sits behind a reverse proxy/load balancer terminating TLS).
- **At rest**: card numbers are stored via `pgcrypto`'s `pgp_sym_encrypt`, not plaintext —
  a stand-in for Db2 for z/OS's pervasive (transparent) data set encryption.
- Encryption key is supplied via environment variable, never hardcoded — in a real
  deployment this would come from a KMS/HSM, not an env var.

## 4. Audit & non-repudiation
- Every login attempt (success and failure) and every transaction (posted, rejected,
  or errored) writes an `audit_log` row with actor, action, target, detail, and IP.
- A Postgres trigger (`reject_audit_mutation`) rejects any `UPDATE`/`DELETE` on
  `audit_log` — it is append-only by construction, not just by convention. This
  mirrors how Db2/SMF audit records can't be edited after the fact.

## 5. Network-layer hardening
- `helmet` sets standard security headers (no `X-Powered-By`, HSTS, etc.).
- Global rate limiting (100 req/min) on all API traffic, plus a tighter limit
  (10 attempts / 15 min) specifically on `/api/login` to blunt credential stuffing.
- CORS is explicit rather than wide-open.

## 6. Data integrity
- Transfers/withdrawals use `SELECT ... FOR UPDATE` plus a DB transaction (`BEGIN`/
  `COMMIT`/`ROLLBACK`) so a crash mid-transfer can't leave money debited from one
  account without crediting the other — the same atomicity guarantee a real IMS/Db2
  two-phase commit provides across resource managers.
- The COBOL engine independently re-validates the math (sufficient funds, positive
  amount) rather than trusting the caller — defense in depth between layers.

## 7. Idempotency and safe retries
- `POST /api/transactions` accepts an optional `Idempotency-Key` header. If a
  request with that key already completed, the gateway returns the cached
  response instead of re-running the transaction — a client retry (dropped
  connection, timeout, double-click) can never double-post money.
- This is tested explicitly: the same request sent twice with the same key
  produces one transaction and one balance change, verified in `test/`.

## 8. Resilience: load-balanced COBOL engine + message queue decoupling
- Two independent COBOL engine containers sit behind an nginx load balancer
  (`cobol-lb`) with automatic failover (`proxy_next_upstream`) — a single
  engine crash does not take down transaction processing. Verified by
  stopping one instance mid-traffic and confirming zero failed requests.
- Fraud scoring runs as a separate consumer reading from RabbitMQ, not inline
  in the request path — a slow, down, or overloaded fraud scorer can never
  slow down or block a teller posting a transaction. Messages that fail
  processing are nacked without requeue rather than retried forever on a
  poison message.

## 9. Observability
- `/metrics` exposes Prometheus-format counters (transactions by type/status)
  and HTTP latency histograms — the same shape a real ops team would scrape
  into Grafana.
- All gateway logs are structured JSON (pino), not free-text console output,
  so they're directly ingestible by Splunk/ELK/CloudWatch.

## 10. Things explicitly out of scope for this demo (and why)
- Real mutual-TLS between services, a KMS-backed key hierarchy, and SIEM integration
  are what a production mainframe shop would add on top of this — omitted here to
  keep the project runnable in an afternoon, but worth naming in an interview as
  "what I'd add for production."
