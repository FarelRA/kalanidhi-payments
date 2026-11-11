/**
 * Structured JSON logger.
 *
 * Two hard rules:
 *  1. Never log request/response bodies, provider payloads, QRIS strings,
 *     OTPs, tokens, vault passphrases, or webhook secrets.
 *  2. Redact defensively by key name and by text pattern, so an accidental
 *     field cannot leak through.
 */
import { currentRequestId } from "./requestContext.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

export interface AppLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): AppLogger;
}

/** Keys that can carry credentials, PII, or QR payloads. */
const SENSITIVE_KEY =
  /pass(?:phrase|word)?|secret|token|otp|authorization|cookie|signature|qr(?:is|_?string|_?payload)?|api[-_]?key|internal[-_]?key|credential|body|payload|phone|msisdn/i;

const BEARER_PATTERN = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const ASSIGNMENT_PATTERN =
  /\b(access[_ -]?token|refresh[_ -]?token|otp[_ -]?token|otp|passphrase|secret|signature|internal[_ -]?key)\b\s*[:=]\s*\S+/gi;
const LONG_HEX_PATTERN = /\b[0-9a-f]{64,}\b/gi;

/** Remove credential-shaped substrings from free text before logging it. */
export function scrubText(input: string): string {
  return input
    .replace(BEARER_PATTERN, "$1 [redacted]")
    .replace(ASSIGNMENT_PATTERN, "$1=[redacted]")
    .replace(LONG_HEX_PATTERN, "[redacted]");
}

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;

function redactValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return scrubText(value);
    if (typeof value === "bigint") return value.toString();
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code;
    return {
      name: value.name,
      ...(typeof code === "string" ? { code } : {}),
      message: scrubText(value.message),
    };
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY)
      .map((item) => redactValue(item, depth + 1, seen));
    if (value.length > MAX_ARRAY) items.push("[truncated]");
    return items;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key)
      ? REDACTED
      : redactValue(child, depth + 1, seen);
  }
  return result;
}

/** Deep-redact a log fields object. Exported for tests. */
export function redactFields(fields: LogFields): LogFields {
  return redactValue(fields, 0, new WeakSet()) as LogFields;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** Test seam; defaults to stdout for info/debug and stderr for warn/error. */
  write?: (level: LogLevel, line: string) => void;
  base?: LogFields;
}

function defaultWrite(level: LogLevel, line: string): void {
  if (level === "warn" || level === "error") {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export function createLogger(options: CreateLoggerOptions = {}): AppLogger {
  const threshold = LEVEL_ORDER[options.level ?? "info"];
  const write = options.write ?? defaultWrite;
  const base = options.base ?? {};

  const create = (baseFields: LogFields): AppLogger => {
    const emit = (
      level: LogLevel,
      message: string,
      fields?: LogFields,
    ): void => {
      if (LEVEL_ORDER[level] < threshold) return;
      const requestId = currentRequestId();
      const entry = redactFields({
        ts: new Date().toISOString(),
        level,
        msg: scrubText(message),
        ...(requestId !== undefined ? { requestId } : {}),
        ...baseFields,
        ...(fields ?? {}),
      });
      write(level, JSON.stringify(entry));
    };

    return {
      debug: (message, fields) => emit("debug", message, fields),
      info: (message, fields) => emit("info", message, fields),
      warn: (message, fields) => emit("warn", message, fields),
      error: (message, fields) => emit("error", message, fields),
      child: (fields) => create({ ...baseFields, ...fields }),
    };
  };

  return create(base);
}
