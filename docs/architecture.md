# Architecture

## Why this project maps to the GM job posting

GM's posting describes their Mainframe Ecosystem team building "horizontal shared
services" on a "modern Parallel Sysplex," bridging hybrid-cloud applications into
core IMS/Db2 transactions, with preferred skills in **z/OS v2.5/v3.1, IMS/DB2, and
the IBM Mainframe Product Set** — plus responsibilities around TDD, CI, and
automated delivery pipelines. This project reproduces that full shape: a modern
API layer, a load-balanced COBOL transactional core, a nightly batch job, an
event-driven analytics consumer, and a CI pipeline that tests all of it — using
tools that run locally, so every piece is something you can describe and defend
in an interview.

## Component diagram

```
┌─────────────┐   HTTPS/JWT    ┌──────────────────┐
│  React UI   │ ─────────────▶ │  Node/Express     │
│ (teller /   │ ◀───────────── │  Gateway           │
│  auditor)   │                │  - JWT/RBAC        │
└─────────────┘                │  - rate limiting   │
                                │  - idempotency keys │
                                │  - /metrics (Prom)  │
                                │  - structured logs  │
                                └────────┬───────────┘
                                         │
                   ┌─────────────────────┼─────────────────────┐
                   │ SQL (pg)            │ HTTP (JSON)          │ AMQP publish
                   ▼                     ▼                      ▼
        ┌────────────────────┐  ┌──────────────────┐   ┌───────────────────┐
        │ PostgreSQL          │  │  cobol-lb (nginx)  │   │  RabbitMQ           │
        │ (Db2-for-z/OS       │  │  round-robin LB +   │   │  topic exchange     │
        │  stand-in)           │  │  automatic failover │   │  "transactions"      │
        │ - pgcrypto columns   │  └─────────┬───────────┘   └─────────┬───────────┘
        │ - append-only audit  │            │                         │
        │ - RBAC roles          │   ┌────────┴────────┐                │
        │ - idempotency_keys    │   ▼                 ▼                ▼
        │ - fraud_alerts        │ ┌─────────┐  ┌─────────┐    ┌────────────────────┐
        │ - batch_runs           │ │engine-a │  │engine-b │    │  fraud-consumer      │
        └──────────▲─────────────┘ │(GnuCOBOL)│  │(GnuCOBOL)│    │  Welford's z-score   │
                   │               └─────────┘  └─────────┘    │  anomaly scoring      │
                   │ SQL (direct)                               └────────────────────┘
                   │
        ┌──────────┴───────────┐
        │  batch-scheduler       │
        │  cron + INTEREST.cob   │
        │  (JCL batch-window      │
        │   analog)                │
        └───────────────────────┘
```

## Request flow: posting a transaction (synchronous path)

1. Teller submits a DEPOSIT/WITHDRAW/TRANSFER from the UI, optionally with an
   `Idempotency-Key` header.
2. Gateway checks `idempotency_keys` first — if this exact request already
   completed, it replays the cached response instead of processing again.
   This is what stops a dropped network response + client retry from
   double-posting money, the same problem CICS/IMS transaction backout solves.
3. Gateway authenticates the JWT and checks the caller's role is `TELLER`.
4. Gateway opens a Postgres transaction and locks the affected account row(s)
   with `SELECT ... FOR UPDATE`.
5. Gateway calls `cobol-lb`, an nginx load balancer in front of **two
   independent COBOL engine containers** (`cobol-engine-a`/`-b`). The COBOL
   program — not the gateway — owns the business rule (sufficient funds,
   positive amount, valid type). If one engine instance is down, nginx
   automatically retries the other (`proxy_next_upstream`), which I verified
   by stopping `cobol-engine-a` mid-traffic and confirming zero failed
   requests. This mirrors how Parallel Sysplex spreads IMS/Db2 workload
   across multiple z/OS images with no single point of failure.
6. Gateway commits the balance updates, the transaction record, and (if an
   idempotency key was given) the cached response — all atomically.
7. **After** the commit, the gateway publishes a `transaction.completed`
   event to RabbitMQ. This is fire-and-forget from the gateway's perspective:
   a slow or down broker must never block or roll back money that already
   moved — the same decoupling a real shop gets from MQ-based integration
   between CICS/IMS and downstream analytics.

## Asynchronous path: fraud scoring

The `fraud-consumer` service subscribes to `transaction.completed` independently
of the request path above. For each event it:
- Looks up the account's running mean/variance (stored incrementally with
  Welford's online algorithm — no full transaction history scan needed).
- Flags the transaction if it's a statistical outlier (z-score ≥ 3) or crosses
  a flat large-amount threshold.
- Writes to `fraud_alerts`, visible to auditors in the UI.

This is explicitly a **rule-based + statistical** detector, not a trained ML
model — framed honestly, but it plugs into the exact event-driven integration
point a real model would use, which is the piece that matters for GM's
"future AI projects on the horizon" line.

## Batch path: nightly interest accrual

`batch-scheduler` plays the role of JES2/the job scheduler: cron (on a 3-minute
demo cadence, documented as standing in for a real nightly run) invokes
`interest_batch.py`, which iterates every ACTIVE account, calls a **second**
COBOL program (`INTEREST.cob`, via the same `cobol-lb` load balancer) to compute
one day's accrual, posts an `INTEREST` transaction, and logs the run to
`batch_runs` (accounts processed, total accrued, success/failure) — the same
operational visibility a real batch window's job log gives you.

## Mapping to real IBM Mainframe Product Set concepts

| This project | Real z/OS/IMS/Db2 equivalent | Notes |
|---|---|---|
| `TXNENGINE.cob` / `INTEREST.cob` | IMS TM transaction program / COBOL batch job | Online and batch COBOL programs, same split real shops use. |
| Flask bridge (`bridge.py`) | IMS Connect / z/OS Connect EE | Exposes a legacy transaction as a REST/JSON callable service. |
| `cobol-lb` + 2 engine replicas | Parallel Sysplex | Workload spread across multiple instances with automatic failover; real Sysplex also shares the underlying data, not just load-balances requests. |
| `batch-scheduler` (cron) | JES2 / job scheduler | Starts the batch job on a schedule; the job itself doesn't know or care how it was invoked. |
| RabbitMQ topic exchange | IBM MQ | Durable, decoupled messaging between the transactional core and downstream systems. |
| `fraud-consumer` | Real-time analytics/AI bridge off IMS/Db2 | Same event-driven integration point a production fraud/ML service would use. |
| Postgres + pgcrypto | Db2 for z/OS with pervasive data set encryption | Real Db2 encrypts at the data-set level transparently; pgcrypto encrypts specific columns explicitly — same outcome, different mechanism. |
| `idempotency_keys` table | CICS/IMS transaction backout & retry safety | Both guarantee a retried request can't be applied twice. |
| `app_users.role` + route guards | Db2 `GRANT`/`REVOKE`, RACF | Both enforce least privilege. |
| `audit_log` (append-only trigger) | Db2 audit facility / SMF records | Tamper-resistant compliance trail. |
| `/metrics` (Prometheus) + structured JSON logs | RMF / SMF performance & operations data | Both give operators a machine-readable view of system health. |
| `.github/workflows/ci.yml` | A mainframe shop's CI/CD pipeline | Builds every image, runs unit tests and a COBOL business-rule regression suite on every push — directly maps to the JD's "test-driven development, continuous integration, automated delivery pipelines" line. |

## If you want to go further: real z/OS practice

- **IBM Z Xplore** (free): a live z/OS system over a browser, with VS Code +
  Zowe Explorer for JCL, COBOL, and Db2/SQL exercises — the legitimate way to
  get real z/OS/Db2 hands-on time before an interview.
- **Db2 Community Edition on x86_64** (not this machine): if you have access to
  an Intel/AMD Linux box or cloud VM, real Db2 can swap in for the Postgres
  container here with minimal SQL changes.
