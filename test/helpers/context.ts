import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  WebhookDeliveryOptions,
  WebhookDeliveryResult,
} from "merchantid/webhook";

import type {
  AppConfig,
  ReconcileConfig,
  WebhookConfig,
} from "../../src/config.js";
import { createGateway, type Gateway } from "../../src/container.js";
import type { PaymentsCore, SessionGateway } from "../../src/domain/types.js";
import { createLogger, type AppLogger } from "../../src/logger.js";
import { makeConfig } from "./config.js";
import { FakePaymentsCore } from "./fakeCore.js";

export interface ContextOptions {
  dir?: string;
  storePath?: string;
  config?: Omit<Partial<AppConfig>, "webhook" | "reconcile"> & {
    webhook?: Partial<WebhookConfig>;
    reconcile?: Partial<ReconcileConfig>;
  };
  webhookDeliver?: (
    options: WebhookDeliveryOptions,
  ) => Promise<WebhookDeliveryResult>;
  logLevel?: "debug" | "info" | "warn" | "error";
  core?: PaymentsCore & SessionGateway;
  fakeOptions?: {
    sessionPresent?: boolean;
    maxOffset?: number;
  };
}

export interface TestContext {
  dir: string;
  config: AppConfig;
  gateway: Gateway;
  core: PaymentsCore & SessionGateway;
  fake: FakePaymentsCore | undefined;
  clock: { value: number };
  logs: string[];
  logger: AppLogger;
  app: Gateway["app"];
  request(path: string, init?: RequestInit): Promise<Response>;
  rawRequest(path: string, init?: RequestInit): Promise<Response>;
  advance(ms: number): void;
  json<T>(response: Response): Promise<T>;
  close(): Promise<void>;
}

function testLogger(
  logs: string[],
  level: "debug" | "info" | "warn" | "error",
): AppLogger {
  return createLogger({
    level,
    write: (_level, line) => logs.push(line),
  });
}

export async function createTestContext(
  options: ContextOptions = {},
): Promise<TestContext> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "kalanidhi-payments-"));
  const storePath = options.storePath ?? join(dir, "payments.sqlite");
  const config: AppConfig = {
    ...makeConfig({ storePath, webhook: options.config?.webhook }),
    ...options.config,
    webhook: {
      ...makeConfig({ storePath, webhook: options.config?.webhook }).webhook,
      ...options.config?.webhook,
    },
    reconcile: {
      ...makeConfig({ storePath }).reconcile,
      ...options.config?.reconcile,
    },
  };

  const clock = { value: Date.now() };
  const fake =
    options.core === undefined
      ? new FakePaymentsCore({
          now: () => clock.value,
          merchantId: config.gopayMerchantId,
          clockSkewMs: config.reconcile.clockSkewMs,
          maxOffset:
            options.fakeOptions?.maxOffset ?? config.reconcile.maxUniqueOffset,
          sessionPresent: options.fakeOptions?.sessionPresent ?? true,
        })
      : undefined;
  const core = options.core ?? fake;
  if (!core) throw new Error("core initialization failed");

  const logs: string[] = [];
  const logger = testLogger(logs, options.logLevel ?? "error");
  const gateway = await createGateway({
    config,
    logger,
    core,
    webhookDeliver: options.webhookDeliver,
    resolveDns: false,
    now: () => clock.value,
    startedAt: clock.value,
  });

  const request = async (
    path: string,
    init: RequestInit = {},
    auth = true,
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (auth) headers.set("x-internal-key", config.internalKey);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return gateway.app.request(path, { ...init, headers });
  };

  return {
    dir,
    config,
    gateway,
    core,
    fake,
    clock,
    logs,
    logger,
    app: gateway.app,
    request: (path, init) => request(path, init, true),
    rawRequest: (path, init) => request(path, init, false),
    advance(ms) {
      clock.value += ms;
    },
    async json<T>(response: Response): Promise<T> {
      return (await response.json()) as T;
    },
    async close() {
      await gateway.close();
      (core as { close?: () => void }).close?.();
      if (options.dir === undefined) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
