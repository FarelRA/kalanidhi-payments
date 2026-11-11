import type { Logger } from "merchantid";

import type { AppLogger } from "../logger.js";

/**
 * Metadata keys emitted by `merchantid`. Everything else is dropped before it
 * reaches the gateway logger, so provider/library logs cannot leak response
 * bodies, headers, tokens, cookies, or QRIS payloads by accident.
 */
const ALLOWED_META = new Set([
  "id",
  "paymentId",
  "transactionId",
  "status",
  "method",
  "host",
  "path",
  "event",
  "code",
  "pages",
  "pageSize",
  "provider",
  "intervalMs",
  "bufferMs",
  "expiresAt",
  "newExpiresAt",
]);

/**
 * Adapter that keeps the library's log messages but strips its metadata down
 * to an allow-list of non-secret operational fields.
 */
export function createSafeCoreLogger(logger: AppLogger): Logger {
  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: string, meta?: Record<string, unknown>): void => {
      const filtered: Record<string, unknown> = {};
      if (meta) {
        for (const [key, value] of Object.entries(meta)) {
          if (ALLOWED_META.has(key)) filtered[key] = value;
        }
      }
      logger[level](message, filtered);
    };

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}
