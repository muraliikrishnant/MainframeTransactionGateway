-- Core relational schema for Mainframe Transaction Gateway
-- Stands in for Db2 for z/OS. Mirrors Db2 concepts:
--   - Db2 native "pervasive encryption" at rest  -> pgcrypto column-level encryption below
--   - Db2 roles / GRANT model                     -> Postgres ROLE + GRANT statements below
--   - Db2 audit facility (IFCID records)           -> audit_log table + trigger

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- RBAC roles (mirrors Db2 SYSADM / SYSCTRL / role-based grants)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'role_teller') THEN
    CREATE ROLE role_teller;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'role_auditor') THEN
    CREATE ROLE role_auditor;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Accounts (the "IMS DB segment" equivalent — core customer/account record)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  account_id       BIGSERIAL PRIMARY KEY,
  account_number   VARCHAR(20) NOT NULL UNIQUE,
  holder_name       VARCHAR(100) NOT NULL,
  -- sensitive field stored encrypted at rest (pgcrypto), never stored in plaintext.
  -- This mirrors Db2 for z/OS "pervasive data set encryption" being transparent to app code.
  card_number_enc  BYTEA,
  balance_cents    BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  status           VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
  -- running statistics used by the fraud-detection consumer for per-account
  -- anomaly scoring (incremental mean/variance, Welford's method) instead of
  -- rescanning full transaction history on every event.
  txn_count        BIGINT NOT NULL DEFAULT 0,
  avg_amount_cents  DOUBLE PRECISION NOT NULL DEFAULT 0,
  variance_accum   DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Transactions (the "IMS TM transaction log" equivalent — every posted txn)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id    BIGSERIAL PRIMARY KEY,
  txn_ref           VARCHAR(36) NOT NULL UNIQUE,
  txn_type          VARCHAR(10) NOT NULL CHECK (txn_type IN ('DEPOSIT','WITHDRAW','TRANSFER','INTEREST')),
  from_account_id   BIGINT REFERENCES accounts(account_id),
  to_account_id     BIGINT REFERENCES accounts(account_id),
  amount_cents      BIGINT NOT NULL CHECK (amount_cents > 0),
  status            VARCHAR(10) NOT NULL CHECK (status IN ('POSTED','REJECTED')),
  reject_reason     VARCHAR(200),
  cobol_engine_trace VARCHAR(200),
  origin            VARCHAR(10) NOT NULL DEFAULT 'TELLER' CHECK (origin IN ('TELLER','BATCH')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_txn_from ON transactions(from_account_id);
CREATE INDEX IF NOT EXISTS idx_txn_to   ON transactions(to_account_id);

-- ---------------------------------------------------------------------------
-- Users (gateway-level auth; teller / auditor roles)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_users (
  user_id         BIGSERIAL PRIMARY KEY,
  username        VARCHAR(50) NOT NULL UNIQUE,
  password_hash   VARCHAR(100) NOT NULL,
  role            VARCHAR(10) NOT NULL CHECK (role IN ('TELLER','AUDITOR')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Audit log (mirrors Db2 IFCID / SMF audit records — immutable, append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id      BIGSERIAL PRIMARY KEY,
  actor         VARCHAR(50) NOT NULL,
  action        VARCHAR(50) NOT NULL,
  target        VARCHAR(100),
  detail        JSONB,
  ip_address    VARCHAR(45),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Idempotency keys — safe retry of a POST /api/transactions call without
-- double-posting money. Mirrors how CICS/IMS handle transaction backout and
-- retry: a client retrying a dropped response must get the SAME result, not
-- a second debit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key   VARCHAR(100) PRIMARY KEY,
  response_status   INT NOT NULL,
  response_body     JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Batch runs — log of nightly batch job executions (the JCL batch-window
-- equivalent: INTEREST.cob run once per night across all active accounts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batch_runs (
  batch_run_id      BIGSERIAL PRIMARY KEY,
  job_name          VARCHAR(50) NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  accounts_processed INT NOT NULL DEFAULT 0,
  total_interest_cents BIGINT NOT NULL DEFAULT 0,
  status            VARCHAR(10) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCESS','FAILED')),
  detail            VARCHAR(500)
);

-- ---------------------------------------------------------------------------
-- Fraud alerts — written asynchronously by the fraud-consumer service after
-- it reads a "transaction.completed" event off the message queue. Decoupled
-- from the transaction-posting path so scoring never slows down a teller.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fraud_alerts (
  alert_id        BIGSERIAL PRIMARY KEY,
  transaction_id  BIGINT REFERENCES transactions(transaction_id),
  account_id      BIGINT REFERENCES accounts(account_id),
  reason          VARCHAR(200) NOT NULL,
  score           DOUBLE PRECISION NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevent UPDATE/DELETE on audit_log at the DB level (append-only, like SMF records)
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_no_update ON audit_log;
CREATE TRIGGER trg_audit_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- Grants (least privilege, mirrors Db2 GRANT SELECT/INSERT ON ... TO ROLE)
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON accounts, transactions TO role_teller;
GRANT SELECT ON audit_log, transactions, accounts, fraud_alerts, batch_runs TO role_auditor;
GRANT INSERT ON audit_log TO role_teller, role_auditor;

-- ---------------------------------------------------------------------------
-- Seed demo data
-- ---------------------------------------------------------------------------
INSERT INTO accounts (account_number, holder_name, card_number_enc, balance_cents)
VALUES
  ('ACC-100001', 'Alice Nguyen',  pgp_sym_encrypt('4111111111111111', 'dev_only_32_byte_key_change_me!'), 500000),
  ('ACC-100002', 'Bob Alvarez',   pgp_sym_encrypt('4222222222222222', 'dev_only_32_byte_key_change_me!'), 250000),
  ('ACC-100003', 'Carla Simmons', pgp_sym_encrypt('4333333333333333', 'dev_only_32_byte_key_change_me!'), 1000000)
ON CONFLICT (account_number) DO NOTHING;

-- demo users: teller / teller123, auditor / auditor123 (bcrypt hashes generated at build time by gateway seed script)
