import client from "prom-client";

client.collectDefaultMetrics();

export const registry = client.register;

export const transactionCounter = new client.Counter({
  name: "mtg_transactions_total",
  help: "Total transactions processed by the gateway, by type and status",
  labelNames: ["txn_type", "status"],
});

export const httpDuration = new client.Histogram({
  name: "mtg_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

export function httpMetricsMiddleware(req, res, next) {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    end({
      method: req.method,
      route: req.route?.path || req.path,
      status_code: res.statusCode,
    });
  });
  next();
}
