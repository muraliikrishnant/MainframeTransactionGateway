# Resume bullets & interview talking points

## Resume bullet options (pick 3-4, tailor to your actual contribution/effort)

- Designed and built a hybrid-cloud transaction gateway bridging a modern REST
  API into two COBOL-based transactional engines behind a load balancer,
  modeling the IMS Connect / Parallel Sysplex patterns used in enterprise
  mainframe modernization; verified automatic failover by killing one engine
  instance mid-traffic with zero failed requests.
- Implemented an event-driven fraud-detection pipeline (RabbitMQ + a Python
  consumer running Welford's online algorithm for incremental z-score
  anomaly detection) fully decoupled from the transaction-posting path, so
  scoring load never affects teller-facing latency.
- Built a nightly batch-processing job (a second COBOL program, scheduled via
  cron, with full run-history logging) to simulate a JCL batch window for
  interest accrual across all active accounts.
- Added idempotency-key support to the transaction API to guarantee
  exactly-once posting under client retries — the same problem CICS/IMS
  transaction backout solves on a real mainframe.
- Implemented role-based access control, JWT authentication, and column-level
  encryption at rest on a relational core-banking schema, mirroring Db2 for
  z/OS security controls (GRANT-based roles, pervasive encryption).
- Built an append-only audit trail enforced at the database level
  (trigger-based) for financial transaction compliance, and exposed
  Prometheus metrics + structured JSON logging for operational visibility.
- Set up a CI pipeline (GitHub Actions) that builds every service image, runs
  a Jest unit test suite, and runs an HTTP-level regression suite against the
  live compiled COBOL binaries on every push.

## Talking points if asked "tell me about a mainframe project you've done"

1. **Start with the honest framing**: "I don't have production z/OS access yet,
   so I built a project that reproduces the same integration patterns — COBOL
   transaction engines behind a load balancer, a batch job, message-queue
   decoupling — using GnuCOBOL, Postgres, and RabbitMQ locally."
2. **Lead with the resilience story** (it's the most senior-sounding one):
   "I run two independent COBOL engine containers behind an nginx load
   balancer and tested failover by killing one mid-traffic — zero failed
   requests, because this is the same no-single-point-of-failure principle
   Parallel Sysplex gives you across multiple z/OS images."
3. **Explain the async/queue decision**: "Fraud scoring happens on a
   RabbitMQ consumer, not inline — I didn't want a slow scoring step to ever
   add latency to someone posting a transaction. That's the same reasoning
   behind MQ-based integration between CICS/IMS and downstream analytics."
4. **Explain idempotency if asked about reliability**: "The transaction API
   accepts an idempotency key so a client retry after a dropped response
   can't double-post money — same problem CICS/IMS transaction backout solves."
5. **Explain the Db2 stand-in honestly**: "I used Postgres locally because
   IBM's Db2 Docker image needs an x86_64/AVX2 CPU and I'm on Apple Silicon —
   every Db2 security feature I built (encrypted columns, RBAC via grants,
   append-only audit) is mapped to its real Db2 for z/OS equivalent in the repo."
6. **Mention CI if asked about engineering practices**: "Every push runs a
   GitHub Actions pipeline that builds all six service images, runs unit
   tests, and runs an HTTP regression suite against the actual compiled
   COBOL binaries — not mocks."
7. **Mention IBM Z Xplore**: "I've also been using IBM Z Xplore to get real
   hands-on time with z/OS, JCL, and Db2/SQL through VS Code and Zowe
   Explorer" (say this only if you actually do it — it's free).
8. **If asked about Parallel Sysplex specifically**: "My local setup
   load-balances stateless request traffic across two engine replicas;
   Sysplex's bigger trick is multiple z/OS images sharing the *same* Db2/IMS
   data concurrently — that's infrastructure I'd expect to learn on the job."

## Honesty note
Be upfront in interviews that this is a learning/practice project built to
demonstrate initiative and the right mental models, not production mainframe
experience — GM's posting explicitly says "comprehensive training provided"
on the actual tools, so the goal here is showing you already understand *why*
distributed, event-driven, and batch-oriented pieces fit together, not
claiming hands-on z/OS production experience you don't have.
