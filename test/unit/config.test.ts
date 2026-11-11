import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";

const BASE_ENV = {
  GOPAY_MERCHANT_ID: "G000000001",
  GOPAY_STATIC_QRIS: "static-qris-payload",
  INTERNAL_API_KEY: "a".repeat(24),
  SESSION_VAULT_PASSPHRASE: "p".repeat(12),
  WEBHOOK_URL: "https://example.test/api/payments/webhook",
  WEBHOOK_SECRET: "s".repeat(16),
};

function parse(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

describe("configuration", () => {
  it("loads required settings and safe defaults", () => {
    const config = parse();
    expect(config.port).toBe(8080);
    expect(config.host).toBe("127.0.0.1");
    expect(config.logLevel).toBe("info");
    expect(config.storePath).toBe("./data/kalanidhi-payments.sqlite");
    expect(config.webhook.allowHttp).toBe(false);
    expect(config.webhook.allowPrivateNetworks).toBe(false);
    expect(config.webhook.maxAttempts).toBe(8);
    expect(config.reconcile.intervalMs).toBe(15_000);
    expect(config.reconcile.clockSkewMs).toBe(60_000);
    expect(config.reconcile.maxUniqueOffset).toBe(999);
  });

  it("parses booleans and numbers from strings", () => {
    const config = parse({
      PORT: "9000",
      LOG_LEVEL: "debug",
      WEBHOOK_ALLOW_HTTP: "true",
      WEBHOOK_URL: "http://127.0.0.1:9001/hook",
      RECONCILE_INTERVAL_MS: "5000",
      RECONCILE_JITTER_RATIO: "0",
      MAX_UNIQUE_OFFSET: "50",
    });
    expect(config.port).toBe(9000);
    expect(config.logLevel).toBe("debug");
    expect(config.webhook.allowHttp).toBe(true);
    expect(config.reconcile.intervalMs).toBe(5_000);
    expect(config.reconcile.jitterRatio).toBe(0);
    expect(config.reconcile.maxUniqueOffset).toBe(50);
  });

  it("requires every secret and provider setting", () => {
    for (const key of [
      "GOPAY_MERCHANT_ID",
      "GOPAY_STATIC_QRIS",
      "INTERNAL_API_KEY",
      "SESSION_VAULT_PASSPHRASE",
      "WEBHOOK_URL",
      "WEBHOOK_SECRET",
    ]) {
      expect(() => parse({ [key]: undefined })).toThrow(ConfigError);
    }
  });

  it("enforces secret length and offset bounds", () => {
    expect(() => parse({ INTERNAL_API_KEY: "short" })).toThrow(ConfigError);
    expect(() => parse({ SESSION_VAULT_PASSPHRASE: "short" })).toThrow(
      ConfigError,
    );
    expect(() => parse({ WEBHOOK_SECRET: "short" })).toThrow(ConfigError);
    expect(() => parse({ MAX_UNIQUE_OFFSET: "1000" })).toThrow(ConfigError);
    expect(() => parse({ RECONCILE_JITTER_RATIO: "2" })).toThrow(ConfigError);
    expect(() => parse({ PORT: "0" })).toThrow(ConfigError);
  });

  it("requires HTTPS for the webhook unless explicitly allowed", () => {
    expect(() => parse({ WEBHOOK_URL: "http://example.test/hook" })).toThrow(
      ConfigError,
    );
  });

  it("rejects an in-memory store path", () => {
    expect(() => parse({ STORE_PATH: ":memory:" })).toThrow(ConfigError);
  });

  it("never includes secret values in the error", () => {
    const secret = "a-very-secret-value-that-is-long";
    try {
      parse({ INTERNAL_API_KEY: secret, WEBHOOK_SECRET: "short" });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(secret);
      const issues = (error as ConfigError).issues;
      expect(issues.some((issue) => issue.path === "WEBHOOK_SECRET")).toBe(
        true,
      );
    }
  });
});
