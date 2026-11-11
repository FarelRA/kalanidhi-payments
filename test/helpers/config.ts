import { buildEmv } from "merchantid";

import type {
  AppConfig,
  ReconcileConfig,
  WebhookConfig,
} from "../../src/config.js";

export const TEST_INTERNAL_KEY = "test-internal-key-0123456789abcdef";
export const TEST_WEBHOOK_SECRET = "test-webhook-secret-0123456789abcdef";
export const TEST_VAULT_PASSPHRASE = "test-vault-passphrase-123456";
export const TEST_STATIC_QRIS = buildEmv(
  new Map([
    ["00", "01"],
    ["01", "11"],
    ["59", "KALANIDHI TEST"],
  ]),
);

export interface MakeConfigOptions {
  storePath: string;
  internalKey?: string;
  vaultPassphrase?: string;
  webhook?: Partial<WebhookConfig>;
  reconcile?: Partial<ReconcileConfig>;
}

export function makeConfig(options: MakeConfigOptions): AppConfig {
  return {
    env: "test",
    host: "127.0.0.1",
    port: 0,
    logLevel: "error",
    storePath: options.storePath,
    vaultPassphrase: options.vaultPassphrase ?? TEST_VAULT_PASSPHRASE,
    gopayMerchantId: "G000000001",
    gopayStaticQris: TEST_STATIC_QRIS,
    internalKey: options.internalKey ?? TEST_INTERNAL_KEY,
    webhook: {
      url: "https://example.test/api/payments/webhook",
      secret: TEST_WEBHOOK_SECRET,
      allowHttp: true,
      allowPrivateNetworks: true,
      timeoutMs: 2_000,
      maxAttempts: 8,
      baseDelayMs: 50,
      maxDelayMs: 1_000,
      ...options.webhook,
    },
    reconcile: {
      intervalMs: 15_000,
      jitterRatio: 0.2,
      clockSkewMs: 0,
      defaultExpirySeconds: 600,
      maxUniqueOffset: 999,
      ...options.reconcile,
    },
  };
}
