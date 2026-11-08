"""
interest_batch.py
Stands in for a nightly JCL-scheduled COBOL batch job: iterates every
ACTIVE account, asks the COBOL INTEREST engine (via the load-balanced
cobol-lb endpoint) to compute one day's accrual, posts the result as an
INTEREST transaction, and logs the run to batch_runs.

Run on a schedule by cron inside this container (see crontab) — cron here
plays the role JES2/the mainframe job scheduler plays on z/OS: it starts
the batch window, the job itself doesn't know or care how it was invoked.
"""
import json
import os
import uuid

import psycopg2
import psycopg2.extras
import requests

DATABASE_URL = os.environ["DATABASE_URL"]
COBOL_ENGINE_URL = os.environ.get("COBOL_ENGINE_URL", "http://cobol-lb:9001")
RABBITMQ_URL = os.environ.get("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
DAILY_RATE_BASIS_POINTS = int(os.environ.get("DAILY_RATE_BASIS_POINTS", 3))


def publish_completed_event(transaction_id, account_id, amount_cents, txn_type):
    import pika

    try:
        params = pika.URLParameters(RABBITMQ_URL)
        connection = pika.BlockingConnection(params)
        channel = connection.channel()
        channel.exchange_declare(exchange="transactions", exchange_type="topic", durable=True)
        channel.basic_publish(
            exchange="transactions",
            routing_key="transaction.completed",
            body=json.dumps(
                {
                    "transactionId": transaction_id,
                    "primaryAccountId": account_id,
                    "amountCents": amount_cents,
                    "txnType": txn_type,
                    "origin": "BATCH",
                }
            ),
            properties=pika.BasicProperties(delivery_mode=2),
        )
        connection.close()
    except Exception as exc:
        print(f"warning: could not publish batch event: {exc}", flush=True)


def main():
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    accounts_processed = 0
    total_interest = 0

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """INSERT INTO batch_runs (job_name, status)
               VALUES ('NIGHTLY_INTEREST_ACCRUAL', 'RUNNING') RETURNING batch_run_id"""
        )
        batch_run_id = cur.fetchone()["batch_run_id"]
        conn.commit()

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT account_id, balance_cents FROM accounts WHERE status = 'ACTIVE'")
            accounts = cur.fetchall()

        for acct in accounts:
            resp = requests.post(
                f"{COBOL_ENGINE_URL}/interest",
                json={"balanceCents": acct["balance_cents"], "rateBasisPoints": DAILY_RATE_BASIS_POINTS},
                timeout=5,
            )
            resp.raise_for_status()
            decision = resp.json()
            interest_cents = decision["interestAmountCents"]

            if interest_cents <= 0:
                continue

            txn_ref = str(uuid.uuid4())
            with conn.cursor() as cur:
                cur.execute(
                    """UPDATE accounts SET balance_cents = %s, updated_at = now() WHERE account_id = %s""",
                    (decision["newBalanceCents"], acct["account_id"]),
                )
                cur.execute(
                    """INSERT INTO transactions
                         (txn_ref, txn_type, to_account_id, amount_cents, status, cobol_engine_trace, origin)
                       VALUES (%s, 'INTEREST', %s, %s, 'POSTED', %s, 'BATCH')
                       RETURNING transaction_id""",
                    (txn_ref, acct["account_id"], interest_cents, decision.get("trace")),
                )
                transaction_id = cur.fetchone()[0]
            conn.commit()

            publish_completed_event(transaction_id, acct["account_id"], interest_cents, "INTEREST")

            accounts_processed += 1
            total_interest += interest_cents

        with conn.cursor() as cur:
            cur.execute(
                """UPDATE batch_runs
                   SET finished_at = now(), accounts_processed = %s,
                       total_interest_cents = %s, status = 'SUCCESS'
                   WHERE batch_run_id = %s""",
                (accounts_processed, total_interest, batch_run_id),
            )
        conn.commit()
        print(
            f"batch run {batch_run_id} complete: {accounts_processed} accounts, "
            f"{total_interest} cents accrued",
            flush=True,
        )

    except Exception as exc:
        conn.rollback()
        with conn.cursor() as cur:
            cur.execute(
                """UPDATE batch_runs SET finished_at = now(), status = 'FAILED', detail = %s
                   WHERE batch_run_id = %s""",
                (str(exc)[:500], batch_run_id),
            )
        conn.commit()
        print(f"batch run {batch_run_id} FAILED: {exc}", flush=True)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
