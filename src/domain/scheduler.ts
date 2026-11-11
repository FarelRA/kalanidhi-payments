import type { AppLogger } from "../logger.js";
import { AppError, describeError } from "../errors.js";
import type { ReconcileRunner } from "./reconcileRunner.js";

export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * Symmetric jitter around the base interval. Spreads provider feed polling and
 * prevents synchronized retries after a restart.
 */
export function computeReconcileDelay(
  intervalMs: number,
  jitterRatio: number,
  random: () => number = Math.random,
): number {
  const jitter = (random() * 2 - 1) * intervalMs * jitterRatio;
  return Math.max(250, Math.round(intervalMs + jitter));
}

export interface ReconcileSchedulerOptions {
  runner: ReconcileRunner;
  intervalMs: number;
  jitterRatio: number;
  logger: AppLogger;
  random?: () => number;
  timers?: TimerApi;
}

/**
 * Single-instance periodic reconciler. Never runs a second tick while one is
 * still in flight: the next tick is scheduled only after the previous one
 * settles, and the runner itself also rejects overlap.
 */
export class ReconcileScheduler {
  private readonly random: () => number;
  private readonly timers: TimerApi;
  private started = false;
  private handle: unknown;

  constructor(private readonly options: ReconcileSchedulerOptions) {
    this.random = options.random ?? Math.random;
    this.timers = options.timers ?? defaultTimers;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleNext();
    this.options.logger.info("reconcile scheduler started", {
      intervalMs: this.options.intervalMs,
      jitterRatio: this.options.jitterRatio,
    });
  }

  stop(): void {
    this.started = false;
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }

  private scheduleNext(): void {
    if (!this.started) return;
    const delay = computeReconcileDelay(
      this.options.intervalMs,
      this.options.jitterRatio,
      this.random,
    );
    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined;
      void this.fire();
    }, delay);
  }

  private async fire(): Promise<void> {
    if (!this.started) return;
    try {
      await this.options.runner.run();
    } catch (error) {
      const described = describeError(error);
      if (error instanceof AppError && error.status === 503) {
        this.options.logger.debug("scheduled reconcile skipped", {
          code: error.code,
        });
      } else {
        this.options.logger.error("scheduled reconcile failed", {
          name: described.name,
          code: described.code,
        });
      }
    } finally {
      this.scheduleNext();
    }
  }

  /** Test/diagnostics hook. */
  get isStarted(): boolean {
    return this.started;
  }
}
