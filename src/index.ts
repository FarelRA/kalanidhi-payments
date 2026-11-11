import { serve } from "@hono/node-server";
import type { Server } from "node:http";

import { ConfigError, loadConfig } from "./config.js";
import { createGateway } from "./container.js";
import { createLogger } from "./logger.js";
import { SERVICE_NAME } from "./version.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    const message =
      error instanceof ConfigError
        ? error.message
        : "Configuration could not be loaded";
    process.stderr.write(`${SERVICE_NAME}: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({
    level: config.logLevel,
    base: { service: SERVICE_NAME },
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled promise rejection", { error: reason });
    process.exitCode = 1;
  });
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error });
    process.exit(1);
  });

  let gateway;
  try {
    gateway = await createGateway({ config, logger });
  } catch (error) {
    logger.error("startup failed", { error });
    process.exitCode = 1;
    return;
  }

  const session = gateway.session.state();
  logger.info("gateway starting", {
    env: config.env,
    host: config.host,
    port: config.port,
    storePath: config.storePath,
    session,
    reconcileIntervalMs: config.reconcile.intervalMs,
    reconcileJitterRatio: config.reconcile.jitterRatio,
    defaultExpirySeconds: config.reconcile.defaultExpirySeconds,
    webhookConfigured: true,
  });

  gateway.scheduler.start();

  let server;
  try {
    server = serve(
      { fetch: gateway.app.fetch, hostname: config.host, port: config.port },
      (info) => {
        logger.info("http server listening", {
          host: info.address,
          port: info.port,
        });
      },
    );
  } catch (error) {
    logger.error("http server failed to start", { error });
    gateway.scheduler.stop();
    await gateway.close();
    process.exitCode = 1;
    return;
  }

  // HTTP/1 is the only protocol this service exposes; the union return type
  // also covers the HTTP/2 adaptor.
  const httpServer = server as Server;
  httpServer.on("error", (error) => {
    logger.error("http server error", { error });
    gateway.scheduler.stop();
    void gateway
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 10_000;
  httpServer.keepAliveTimeout = 5_000;

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      logger.warn("second shutdown signal; exiting immediately", { signal });
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("shutdown started", { signal });
    gateway.scheduler.stop();

    const force = setTimeout(() => {
      logger.error("shutdown timed out");
      process.exit(1);
    }, 10_000);
    force.unref();

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeIdleConnections?.();
    });
    await gateway.close();
    clearTimeout(force);
    logger.info("shutdown complete");
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

void main();
