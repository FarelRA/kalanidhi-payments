import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReconcileRunner } from "../src/domain/reconcileRunner.js";
import {
  computeReconcileDelay,
  ReconcileScheduler,
  type TimerApi,
} from "../src/domain/scheduler.js";
import { createTestContext, type TestContext } from "./helpers/context.js";

interface ReconcileSummary {
  ran: boolean;
  paid: number;
  expired: number;
  webhooksDelivered: number;
  webhooksRetrying: number;
  webhooksDeadLettered: number;
  durationMs: number;
  completedAt: string;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("reconciliation", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.close();
  });

  it("runs one tick and returns a summary", async () => {
    ctx = await createTestContext();
    const created = await ctx.request("/v1/charges", {
      method: "POST",
      body: JSON.stringify({ orderId: "KN-R1", baseAmount: 100_000 }),
    });
    const charge = await ctx.json<{ uniqueAmount: number }>(created);
    ctx.fake?.queueTransaction(charge.uniqueAmount);

    const response = await ctx.request("/v1/reconcile", { method: "POST" });
    expect(response.status).toBe(200);
    const summary = await ctx.json<ReconcileSummary>(response);
    expect(summary.ran).toBe(true);
    expect(summary.paid).toBe(1);
    expect(summary.expired).toBe(0);
    expect(summary.webhooksDelivered).toBeGreaterThanOrEqual(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(summary.completedAt))).toBe(false);
  });

  it("rejects overlapping reconcile calls", async () => {
    ctx = await createTestContext();
    let release!: () => void;
    ctx.fake!.tickGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = ctx.request("/v1/reconcile", { method: "POST" });
    await waitUntil(() => (ctx.fake?.tickCalls ?? 0) === 1);

    const second = await ctx.request("/v1/reconcile", { method: "POST" });
    expect(second.status).toBe(409);
    expect(
      (await ctx.json<{ error: { code: string } }>(second)).error.code,
    ).toBe("RECONCILE_IN_PROGRESS");

    release();
    expect((await first).status).toBe(200);
  });

  it("keeps the last summary across a runner restart", async () => {
    ctx = await createTestContext();
    await ctx.request("/v1/reconcile", { method: "POST" });
    const first = ctx.gateway.runner.last();
    expect(first).toBeDefined();

    const { ReconcileRunner } =
      await import("../src/domain/reconcileRunner.js");
    const restarted = new ReconcileRunner({
      core: ctx.core,
      charges: ctx.gateway.charges,
      repo: ctx.gateway.repo,
      logger: ctx.logger,
      now: () => ctx.clock.value,
    });
    expect(restarted.last()?.completedAt).toBe(first?.completedAt);
  });
});

describe("reconcile scheduler", () => {
  it("keeps jitter inside the configured band", () => {
    for (let i = 0; i < 100; i += 1) {
      const delay = computeReconcileDelay(10_000, 0.2);
      expect(delay).toBeGreaterThanOrEqual(8_000);
      expect(delay).toBeLessThanOrEqual(12_000);
    }
    expect(computeReconcileDelay(10_000, 0, () => 0.99)).toBe(10_000);
    expect(computeReconcileDelay(100, 0.5, () => 0)).toBe(250);
  });

  it("schedules the next run only after the previous run settles", async () => {
    const callbacks: Array<() => void> = [];
    const timers: TimerApi = {
      setTimeout: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimeout: () => undefined,
    };
    let release!: () => void;
    const runs: number[] = [];
    const runner = {
      run: vi.fn(async () => {
        runs.push(runs.length + 1);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ran: true, summary: {} };
      }),
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ReconcileRunner;

    const scheduler = new ReconcileScheduler({
      runner,
      intervalMs: 1_000,
      jitterRatio: 0,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        child() {
          return this;
        },
      },
      timers,
      random: () => 0.5,
    });

    scheduler.start();
    expect(callbacks).toHaveLength(1);
    callbacks[0]?.();
    await Promise.resolve();
    expect(runs).toHaveLength(1);
    expect(callbacks).toHaveLength(1);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(callbacks).toHaveLength(2);
    scheduler.stop();
  });

  it("does not schedule after stop", async () => {
    const callbacks: Array<() => void> = [];
    const timers: TimerApi = {
      setTimeout: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimeout: () => undefined,
    };
    const runner = {
      run: vi.fn(async () => ({ ran: true, summary: {} })),
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as ReconcileRunner;
    const scheduler = new ReconcileScheduler({
      runner,
      intervalMs: 1_000,
      jitterRatio: 0.2,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        child() {
          return this;
        },
      },
      timers,
    });

    scheduler.start();
    scheduler.stop();
    expect(scheduler.isStarted).toBe(false);
    callbacks[0]?.();
    await Promise.resolve();
    expect(runner.run).not.toHaveBeenCalled();
  });
});
