import { describe, expect, it } from "vitest";

import { createLogger, redactFields, scrubText } from "../../src/logger.js";
import { createSafeCoreLogger } from "../../src/domain/safeCoreLogger.js";

describe("structured logger", () => {
  it("writes one JSON object per line with redacted credential fields", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      write: (_level, line) => lines.push(line),
      base: { service: "test" },
    });

    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;

    logger.info("hello", {
      requestId: "req-1",
      token: "should-not-appear",
      qrString: "000201010212",
      nested: { passphrase: "hunter2", ok: "yes" },
      error: new Error("Bearer abc.def.ghi"),
      circular,
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry.service).toBe("test");
    expect(entry.requestId).toBe("req-1");
    expect(entry.token).toBe("[redacted]");
    expect(entry.qrString).toBe("[redacted]");
    expect((entry.nested as Record<string, unknown>).passphrase).toBe(
      "[redacted]",
    );
    expect((entry.nested as Record<string, unknown>).ok).toBe("yes");
    const error = entry.error as Record<string, unknown>;
    expect(error.message).toBe("Bearer [redacted]");
    expect((entry.circular as Record<string, unknown>).self).toBe("[circular]");
    expect(lines[0]).not.toContain("should-not-appear");
    expect(lines[0]).not.toContain("hunter2");
    expect(lines[0]).not.toContain("abc.def.ghi");
  });

  it("scrubs credential-shaped text", () => {
    expect(scrubText("otp=123456")).toBe("otp=[redacted]");
    expect(scrubText("access_token: abc123")).toBe("access_token=[redacted]");
    expect(scrubText(`hmac ${"a".repeat(64)}`)).toBe("hmac [redacted]");
  });

  it("respects the level threshold", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "warn",
      write: (_level, line) => lines.push(line),
    });
    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"level":"warn"');
    expect(lines[1]).toContain('"level":"error"');
  });

  it("merges child fields without mutating the parent", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      write: (_level, line) => lines.push(line),
    }).child({ component: "charges" });
    logger.info("created", { chargeId: "ch_1" });
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry.component).toBe("charges");
    expect(entry.chargeId).toBe("ch_1");
  });

  it("redacts arrays, bigints and null safely", () => {
    const redacted = redactFields({
      values: [1, "two", { secret: "x" }, null],
      big: 10n,
      nothing: null,
    });
    expect(redacted.big).toBe("10");
    expect(redacted.nothing).toBeNull();
    const values = redacted.values as unknown[];
    expect(values[3]).toBeNull();
    expect((values[2] as Record<string, unknown>).secret).toBe("[redacted]");
  });

  it("allow-lists provider-core metadata", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      write: (_level, line) => lines.push(line),
    });
    const coreLogger = createSafeCoreLogger(logger);
    coreLogger.error("core failed", {
      paymentId: "pay_1",
      status: "paid",
      error: "super-secret-provider-body",
      qrString: "000201",
      token: "abc",
    });
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry.paymentId).toBe("pay_1");
    expect(entry.status).toBe("paid");
    expect(entry.error).toBeUndefined();
    expect(entry.qrString).toBeUndefined();
    expect(entry.token).toBeUndefined();
    expect(lines[0]).not.toContain("super-secret-provider-body");
  });
});
