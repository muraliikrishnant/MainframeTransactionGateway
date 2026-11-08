import pino from "pino";

// Structured JSON logs — every line is machine-parseable, matching how a
// real shop would ship gateway logs into Splunk/ELK rather than grepping
// free-text console output.
export const logger = pino({ level: process.env.LOG_LEVEL || "info" });
