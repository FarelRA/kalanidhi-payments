import { SqlitePaymentStore } from "merchantid/sqlite";
import { SessionVault } from "merchantid/vault";
import type { Hono } from "hono";

import type { AppConfig } from "./config.js";
import { openGatewayDatabase, type GatewayDatabase } from "./db.js";
import type { AppLogger } from "./logger.js";
import { ChargeService } from "./domain/chargeService.js";
import { GopayPaymentsCore } from "./domain/gopayCore.js";
import { HealthService } from "./domain/health.js";
import { ReconcileRunner } from "./domain/reconcileRunner.js";
import { ChargeRepository } from "./domain/repository.js";
import { ReconcileScheduler } from "./domain/scheduler.js";
import { SessionManager } from "./domain/sessionManager.js";
import { SessionStore } from "./domain/sessionStore.js";
import type { PaymentsCore, SessionGateway } from "./domain/types.js";
import { WebhookOutbox } from "./domain/webhook.js";
import type { WebhookDeliveryOptions } from "merchantid/webhook";
import type { WebhookDeliveryResult } from "merchantid/webhook";
import { buildApp } from "./http/app.js";
import { SERVICE_VERSION } from "./version.js";

export interface GatewayOptions {
  config: AppConfig;
  logger: AppLogger;
  /** Test seam: replaces the real GoPay adapter. */
  core?: PaymentsCore & SessionGateway;
  /** Test seam: replaces library webhook delivery. */
  webhookDeliver?: (
    options: WebhookDeliveryOptions,
  ) => Promise<WebhookDeliveryResult>;
  resolveDns?: boolean;
  now?: () => number;
  startedAt?: number;
}

export interface Gateway {
  app: Hono<{ Variables: { requestId: string } }>;
  db: GatewayDatabase;
  repo: ChargeRepository;
  core: PaymentsCore & SessionGateway;
  charges: ChargeService;
  session: SessionManager;
  runner: ReconcileRunner;
  health: HealthService;
  scheduler: ReconcileScheduler;
  close(): Promise<void>;
}

/**
 * Compose the gateway. The SQLite payment store and the gateway repository use
 * separate `node:sqlite` connections to the same file; WAL lets them coexist
 * while each write stays atomic.
 */
export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const { config, logger } = options;
  const now = options.now ?? (() => Date.now());
  const db = openGatewayDatabase(config.storePath);
  const repo = new ChargeRepository(db.raw);
  const vault = SessionVault.fromPassphrase(config.vaultPassphrase);
  const sessionStore = new SessionStore(vault, repo, logger, now);
  const loaded = sessionStore.load();

  const sessionRef: { current?: SessionManager } = {};
  let core: PaymentsCore & SessionGateway;
  let ownsCore = false;

  if (options.core) {
    core = options.core;
    if (loaded) await core.adoptSession(loaded);
  } else {
    ownsCore = true;
    const store = new SqlitePaymentStore({
      path: config.storePath,
      busyTimeoutMs: 5_000,
      wal: true,
    });
    core = new GopayPaymentsCore({
      merchantId: config.gopayMerchantId,
      staticQris: config.gopayStaticQris,
      store,
      clockSkewMs: config.reconcile.clockSkewMs,
      defaultExpiryMs: config.reconcile.defaultExpirySeconds * 1_000,
      maxUniqueOffset: config.reconcile.maxUniqueOffset,
      logger,
      initialSession: loaded,
      onSessionRefreshed: async (session) => {
        sessionRef.current?.persistRefreshed(session);
      },
    });
  }

  const sessionManager = new SessionManager({
    gateway: core,
    store: sessionStore,
    logger,
    now,
  });
  sessionRef.current = sessionManager;

  const webhook = new WebhookOutbox({
    repo,
    config: config.webhook,
    logger,
    now,
    deliver: options.webhookDeliver,
    resolveDns: options.resolveDns,
  });

  const charges = new ChargeService({
    core,
    repo,
    webhook,
    logger,
    defaultExpirySeconds: config.reconcile.defaultExpirySeconds,
    now,
  });

  const runner = new ReconcileRunner({
    core,
    charges,
    repo,
    logger,
    now,
  });

  const health = new HealthService({
    version: SERVICE_VERSION,
    startedAt: options.startedAt ?? now(),
    session: sessionManager,
    charges,
    runner,
    now,
  });

  const app = buildApp({
    internalKey: config.internalKey,
    logger,
    charges,
    session: sessionManager,
    runner,
    health,
  });

  const scheduler = new ReconcileScheduler({
    runner,
    intervalMs: config.reconcile.intervalMs,
    jitterRatio: config.reconcile.jitterRatio,
    logger,
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    scheduler.stop();
    await runner.waitForIdle();
    if (ownsCore) core.close?.();
    db.close();
  };

  return {
    app,
    db,
    repo,
    core,
    charges,
    session: sessionManager,
    runner,
    health,
    scheduler,
    close,
  };
}
