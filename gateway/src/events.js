import amqplib from "amqplib";
import { logger } from "./logger.js";

const RABBITMQ_URL = process.env.RABBITMQ_URL;
const EXCHANGE_NAME = "transactions";

let channel = null;

// Connects once at startup and keeps retrying in the background if RabbitMQ
// isn't up yet — the gateway should still serve requests while the broker
// is starting, it just can't publish events until the connection lands.
export async function connectEvents() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const conn = await amqplib.connect(RABBITMQ_URL);
      channel = await conn.createChannel();
      await channel.assertExchange(EXCHANGE_NAME, "topic", { durable: true });
      logger.info("connected to rabbitmq");
      conn.on("close", () => {
        logger.warn("rabbitmq connection closed, events will stop publishing");
        channel = null;
      });
      return;
    } catch (err) {
      logger.warn({ attempt, err: err.message }, "rabbitmq not ready, retrying");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  logger.error("could not connect to rabbitmq after 30 attempts; continuing without events");
}

// Publishing a transaction-completed event is intentionally fire-and-forget
// from the caller's perspective: a slow or down message broker must never
// block or fail a transaction that already committed to the database. This
// is the same decoupling a real mainframe shop gets from MQ-based
// integration between CICS/IMS and downstream analytics.
export function publishTransactionCompleted(event) {
  if (!channel) {
    logger.warn({ event }, "rabbitmq channel unavailable, dropping event");
    return;
  }
  try {
    channel.publish(
      EXCHANGE_NAME,
      "transaction.completed",
      Buffer.from(JSON.stringify(event)),
      { persistent: true, contentType: "application/json" }
    );
  } catch (err) {
    logger.error({ err: err.message }, "failed to publish transaction.completed event");
  }
}
