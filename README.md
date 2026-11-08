# Mainframe Transaction Gateway

A hands-on, resume-worthy demo project built for the **GM Entry-Level Mainframe
Systems Engineer** role (JR-202623745). It reproduces the full architecture
pattern GM describes in that posting — a modern hybrid-cloud API bridging into
a load-balanced COBOL transactional core, backed by a Db2-like relational
store, with a nightly batch job and an event-driven analytics pipeline —
using tools that run on a laptop.

See [`docs/architecture.md`](docs/architecture.md) for the full design and the
real z/OS/IMS/Db2 feature mapping, [`docs/security.md`](docs/security.md) for the
full security control list, and [`docs/resume-talking-points.md`](docs/resume-talking-points.md)
for ready-to-use resume bullets and interview talking points.

## Run it

Requires Docker Desktop running.

```bash
cp .env.example .env     # edit secrets if you want, defaults work for local demo
docker compose up --build
```

Then open:
- UI: http://localhost:5173
- Gateway API: http://localhost:8080 (health: `/health`, metrics: `/metrics`)
- COBOL engine (load-balanced): http://localhost:9001/health
- RabbitMQ management UI: http://localhost:15672 (guest/guest)

Demo logins:
- Teller: `teller1` / `teller123`
- Auditor: `auditor1` / `auditor123` (also see Fraud Alerts + Batch Job History panels)

## Run the tests

```bash
cd gateway && npm install && npm test     # Jest unit tests for auth/RBAC

ENGINE_URL=http://localhost:9001 bash test/cobol_engine.test.sh   # COBOL business-rule regression suite (stack must be running)
```

Both also run automatically in CI on every push (`.github/workflows/ci.yml`).

## What it demonstrates

| Layer | Tech used here | Real mainframe equivalent |
|---|---|---|
| Core transaction logic | 2x GnuCOBOL engine replicas (`txnengine.cob`) behind nginx LB | IMS TM / Parallel Sysplex failover |
| Nightly batch job | `INTEREST.cob` + cron scheduler container | JCL batch window / JES2 |
| Bridge service | Python/Flask wrapping the COBOL binaries | IMS Connect / z/OS Connect |
| Relational store | PostgreSQL + pgcrypto, append-only audit, idempotency keys | Db2 for z/OS (pervasive encryption, SMF audit) |
| Async analytics | RabbitMQ + Python fraud-scoring consumer | IBM MQ bridging core systems to AI/analytics |
| Modern API gateway | Node.js/Express, JWT, RBAC, Prometheus metrics, structured logs | z/OS Connect EE / API Gateway in front of CICS/IMS |
| CI/CD | GitHub Actions: unit tests + live COBOL regression suite + image builds | Mainframe shop's CI pipeline |
| UI | React | Teller/auditor workstation |

I verified, against the running stack, that: a transaction retried with the
same idempotency key does not double-post; stopping one COBOL engine instance
mid-traffic causes zero failed requests (automatic failover); every posted
transaction gets asynchronously scored by the fraud consumer without slowing
down the teller request; and the batch job runs automatically and logs its
results. See `docs/architecture.md` for exactly how each piece was tested.

**Why Postgres instead of real Db2?** IBM's Db2 Community Edition Docker image
requires an x86_64 CPU with AVX2 — it does not run on Apple Silicon (M-series)
Macs, even under emulation. Postgres is used as a drop-in stand-in for local
development; `docs/architecture.md` documents exactly which Db2-specific
features this substitutes for, so you can speak to the real Db2 concepts in
an interview. For real IBM z/OS/Db2/IMS hands-on practice, see **IBM Z
Xplore** (free, browser + VS Code/Zowe access to a live z/OS system).
