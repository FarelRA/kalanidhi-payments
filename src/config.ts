import { z } from "zod";

import type { LogLevel } from "./logger.js";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

function booleanString(defaultValue: "true" | "false") {
  return z
    .enum(["true", "false", "1", "0", ""])
    .default(defaultValue)
    .transform((value) => value === "true" || value === "1");
}

function integerFromEnv(options: {
  defaultValue: number;
  min: number;
  max: number;
}) {
  return z.preprocess((value) => {
    if (value === undefined || value === "") return undefined;
    if (typeof value === "string") return Number(value);
    return value;
  }, z.number().int().min(options.min).max(options.max).default(options.defaultValue));
}

function numberFromEnv(options: {
  defaultValue: number;
  min: number;
  max: number;
}) {
  return z.preprocess((value) => {
    if (value === undefined || value === "") return undefined;
    if (typeof value === "string") return Number(value);
    return value;
  }, z.number().finite().min(options.min).max(options.max).default(options.defaultValue));
}

const optionalUrl = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  }, "must be an absolute http(s) URL without credentials");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: integerFromEnv({ defaultValue: 8080, min: 1, max: 65535 }),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),

  STORE_PATH: z
    .string()
    .min(1)
    .default("./data/kalanidhi-payments.sqlite")
    .refine(
      (value) => value !== ":memory:",
      "must be a durable file path, not :memory:",
    ),
  SESSION_VAULT_PASSPHRASE: z.string().min(12),

  GOPAY_MERCHANT_ID: z.string().trim().min(1),
  GOPAY_STATIC_QRIS: z.string().trim().min(10),

  INTERNAL_API_KEY: z.string().min(24),

  WEBHOOK_URL: optionalUrl,
  WEBHOOK_SECRET: z.string().min(16),
  WEBHOOK_ALLOW_HTTP: booleanString("false"),
  WEBHOOK_ALLOW_PRIVATE_NETWORKS: booleanString("false"),
  WEBHOOK_TIMEOUT_MS: integerFromEnv({
    defaultValue: 5_000,
    min: 250,
    max: 60_000,
  }),
  WEBHOOK_MAX_ATTEMPTS: integerFromEnv({
    defaultValue: 8,
    min: 1,
    max: 20,
  }),
  WEBHOOK_BASE_DELAY_MS: integerFromEnv({
    defaultValue: 1_000,
    min: 50,
    max: 60_000,
  }),
  WEBHOOK_MAX_DELAY_MS: integerFromEnv({
    defaultValue: 60_000,
    min: 100,
    max: 600_000,
  }),

  RECONCILE_INTERVAL_MS: integerFromEnv({
    defaultValue: 15_000,
    min: 1_000,
    max: 3_600_000,
  }),
  RECONCILE_JITTER_RATIO: numberFromEnv({
    defaultValue: 0.2,
    min: 0,
    max: 1,
  }),
  CLOCK_SKEW_MS: integerFromEnv({
    defaultValue: 60_000,
    min: 0,
    max: 300_000,
  }),
  DEFAULT_EXPIRY_SECONDS: integerFromEnv({
    defaultValue: 600,
    min: 30,
    max: 86_400,
  }),
  MAX_UNIQUE_OFFSET: integerFromEnv({
    defaultValue: 999,
    min: 1,
    max: 999,
  }),
});

export interface WebhookConfig {
  url: string;
  secret: string;
  allowHttp: boolean;
  allowPrivateNetworks: boolean;
  timeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface ReconcileConfig {
  intervalMs: number;
  jitterRatio: number;
  clockSkewMs: number;
  defaultExpirySeconds: number;
  maxUniqueOffset: number;
}

export interface AppConfig {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  logLevel: LogLevel;
  storePath: string;
  vaultPassphrase: string;
  gopayMerchantId: string;
  gopayStaticQris: string;
  internalKey: string;
  webhook: WebhookConfig;
  reconcile: ReconcileConfig;
}

export class ConfigError extends Error {
  public readonly issues: Array<{ path: string; message: string }>;

  constructor(issues: Array<{ path: string; message: string }>) {
    super(
      `Invalid configuration: ${issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Parse and validate configuration. Only field paths and rule violations are
 * ever included in the error: values may be secrets.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  const value = parsed.data;

  if (!value.WEBHOOK_ALLOW_HTTP && !value.WEBHOOK_URL.startsWith("https://")) {
    throw new ConfigError([
      {
        path: "WEBHOOK_URL",
        message: "must use https unless WEBHOOK_ALLOW_HTTP=true",
      },
    ]);
  }

  return {
    env: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    storePath: value.STORE_PATH,
    vaultPassphrase: value.SESSION_VAULT_PASSPHRASE,
    gopayMerchantId: value.GOPAY_MERCHANT_ID,
    gopayStaticQris: value.GOPAY_STATIC_QRIS,
    internalKey: value.INTERNAL_API_KEY,
    webhook: {
      url: value.WEBHOOK_URL,
      secret: value.WEBHOOK_SECRET,
      allowHttp: value.WEBHOOK_ALLOW_HTTP,
      allowPrivateNetworks: value.WEBHOOK_ALLOW_PRIVATE_NETWORKS,
      timeoutMs: value.WEBHOOK_TIMEOUT_MS,
      maxAttempts: value.WEBHOOK_MAX_ATTEMPTS,
      baseDelayMs: value.WEBHOOK_BASE_DELAY_MS,
      maxDelayMs: value.WEBHOOK_MAX_DELAY_MS,
    },
    reconcile: {
      intervalMs: value.RECONCILE_INTERVAL_MS,
      jitterRatio: value.RECONCILE_JITTER_RATIO,
      clockSkewMs: value.CLOCK_SKEW_MS,
      defaultExpirySeconds: value.DEFAULT_EXPIRY_SECONDS,
      maxUniqueOffset: value.MAX_UNIQUE_OFFSET,
    },
  };
}
