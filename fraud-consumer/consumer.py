"""
consumer.py
Asynchronous fraud/anomaly scoring service.

Subscribes to the "transaction.completed" events the gateway publishes to
RabbitMQ after every posted transaction, scores each one against that
account's running mean/variance (Welford's online algorithm, so no full
history scan is needed), and writes a fraud_alerts row when a transaction
is a statistical or rule-based outlier.

This is the "shared horizontal service" piece of the architecture: it runs
completely decoupled from the teller-facing request path, so scoring load
or a scoring-service outage never slows down or blocks a posted transaction.
It also stands in for the "future AI projects" GM's posting mentions —
honestly framed as rule-based + statistical anomaly detection, not a trained
ML model, but the same event-driven integration point a real model would
plug into.
"""
import json
import os
import time

import pika
import psycopg2
import psycopg2.extras

RABBITMQ_URL = os.environ.get("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
DATABASE_URL = os.environ.get("DATABASE_URL")
QUEUE_NAME = "fraud-detection.transaction-completed"
EXCHANGE_NAME = "transactions"
ROUTING_KEY = "transaction.completed"

LARGE_TXN_ABSOLUTE_CENTS = 500_000  # $5,000 flat threshold rule
Z_SCORE_THRESHOLD = 3.0  # statistical outlier threshold


def connect_db():
    return psycopg2.connect(DATABASE_URL)


def score_transaction(conn, event):
    account_id = event.get("primaryAccountId")
    amount_cents = event["amountCents"]
    transaction_id = event["transactionId"]

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT txn_count, avg_amount_cents, variance_accum FROM accounts WHERE account_id = %s FOR UPDATE",
            (account_id,),
        )
        row = cur.fetchone()
        if row is None:
            return

        n = row["txn_count"]
        mean = row["avg_amount_cents"]
        m2 = row["variance_accum"]

        reasons = []
        score = 0.0

        if n >= 5:
            variance = m2 / n
            stddev = variance ** 0.5
            if stddev > 0:
                z = abs(amount_cents - mean) / stddev
                if z >= Z_SCORE_THRESHOLD:
                    reasons.append(f"amount is a {z:.1f}-sigma outlier vs account history")
                    score = max(score, z)

        if amount_cents >= LARGE_TXN_ABSOLUTE_CENTS:
            reasons.append("amount exceeds flat large-transaction threshold ($5,000)")
            score = max(score, amount_cents / LARGE_TXN_ABSOLUTE_CENTS)

        if reasons:
            cur.execute(
                """INSERT INTO fraud_alerts (transaction_id, account_id, reason, score)
                   VALUES (%s, %s, %s, %s)""",
                (transaction_id, account_id, "; ".join(reasons), score),
            )

        # Welford's online update: running mean/variance without storing history.
        new_n = n + 1
        delta = amount_cents - mean
        new_mean = mean + delta / new_n
        delta2 = amount_cents - new_mean
        new_m2 = m2 + delta * delta2

        cur.execute(
            """UPDATE accounts SET txn_count = %s, avg_amount_cents = %s, variance_accum = %s
               WHERE account_id = %s""",
            (new_n, new_mean, new_m2, account_id),
        )
        conn.commit()


def main():
    conn = connect_db()

    for attempt in range(30):
        try:
            params = pika.URLParameters(RABBITMQ_URL)
            connection = pika.BlockingConnection(params)
            break
        except pika.exceptions.AMQPConnectionError:
            print(f"rabbitmq not ready, retrying ({attempt + 1}/30)...", flush=True)
            time.sleep(2)
    else:
        raise RuntimeError("could not connect to rabbitmq")

    channel = connection.channel()
    channel.exchange_declare(exchange=EXCHANGE_NAME, exchange_type="topic", durable=True)
    channel.queue_declare(queue=QUEUE_NAME, durable=True)
    channel.queue_bind(exchange=EXCHANGE_NAME, queue=QUEUE_NAME, routing_key=ROUTING_KEY)

    def on_message(ch, method, properties, body):
        try:
            event = json.loads(body)
            score_transaction(conn, event)
            print(f"scored transaction {event.get('transactionId')}", flush=True)
            ch.basic_ack(delivery_tag=method.delivery_tag)
        except Exception as exc:
            conn.rollback()
            print(f"error scoring transaction: {exc}", flush=True)
            # requeue=False sends it to the dead-letter path instead of retrying
            # forever on a message that will never succeed (poison message).
            ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

    channel.basic_consume(queue=QUEUE_NAME, on_message_callback=on_message)
    print("fraud-consumer listening for transaction.completed events...", flush=True)
    channel.start_consuming()


if __name__ == "__main__":
    main()
