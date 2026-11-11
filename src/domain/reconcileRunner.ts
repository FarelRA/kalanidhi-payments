import type { AppLogger } from "../logger.js";
import { AppError, SessionUnavailableError, describeError } from "../errors.js";
import { mapCoreError } from "./coreErrors.js";
import type { ChargeService } from "./chargeService.js";
import type { ChargeRepository } from "./repository.js";
import type { PaymentsCore } from "./types.js";

export interface ReconcileSummary {
  ran: true;
  paid: number;
  expired: number;
  webhooksDelivered: number;
  webhooksRetrying: number;
  webhooksDeadLettered: number;
  durationMs: number;
  completedAt: string;
}

export type ReconcileOutcome =
  | { ran: true; summary: ReconcileSummary }
  | { ran: false; reason: "already_running" };

const META_KEY = "last_reconcile";

export interface ReconcileRunnerOptions {
  core: PaymentsCore;
  charges: ChargeService;
  repo: ChargeRepository;
  logger: AppLogger;
  now?: () => number;
}

/**
 * One reconcile tick per call, guarded against overlap across the scheduler and
 * the manual `/v1/reconcile` endpoint.
 */
export class ReconcileRunner {
  private readonly now: () => number;
  private inFlight = false;
  private idleWaiters: Array<() => void> = [];
  private lastSummary: ReconcileSummary | undefined;
  private lastFailureAt: string | undefined;

  constructor(private readonly options: ReconcileRunnerOptions) {
    this.now = options.now ?? (() => Date.now());
    const stored = options.repo.getMeta(META_KEY);
    if (stored) {
      try {
        this.lastSummary = JSON.parse(stored) as ReconcileSummary;
      } catch {
        this.lastSummary = undefined;
      }
    }
  }

  get running(): boolean {
    return this.inFlight;
  }

  last(): ReconcileSummary | undefined {
    return this.lastSummary;
  }

  lastFailure(): string | undefined {
    return this.lastFailureAt;
  }

  async run(): Promise<ReconcileOutcome> {
    if (this.inFlight) return { ran: false, reason: "already_running" };

    this.inFlight = true;
    const startedAt = this.now();
    try {
      if (!this.options.core.hasSession()) {
        // Webhook retries do not need the provider session. Keep draining the
        // outbox even when reconciliation itself must pause.
        await this.options.charges.deliverWebhooks();
        throw new SessionUnavailableError();
      }

      const tick = await this.options.core.tick();
      await this.options.charges.syncPendingStatuses();
      const delivery = await this.options.charges.deliverWebhooks();
      const completedAt = this.now();
      const summary: ReconcileSummary = {
        ran: true,
        paid: tick.paid.length,
        expired: tick.expired.length,
        webhooksDelivered: delivery.delivered,
        webhooksRetrying: delivery.retrying,
        webhooksDeadLettered: delivery.dead,
        durationMs: completedAt - startedAt,
        completedAt: new Date(completedAt).toISOString(),
      };
      this.lastSummary = summary;
      this.lastFailureAt = undefined;
      this.options.repo.setMeta(META_KEY, JSON.stringify(summary));
      this.options.logger.info("reconcile completed", {
        paid: summary.paid,
        expired: summary.expired,
        webhooksDelivered: summary.webhooksDelivered,
        webhooksRetrying: summary.webhooksRetrying,
        webhooksDeadLettered: summary.webhooksDeadLettered,
        durationMs: summary.durationMs,
      });
      return { ran: true, summary };
    } catch (error) {
      const mapped = mapCoreError(error);
      this.lastFailureAt = new Date(this.now()).toISOString();
      const described = describeError(mapped);
      if (mapped instanceof AppError && mapped.status === 503) {
        this.options.logger.debug("reconcile skipped", {
          code: mapped.code,
        });
      } else {
        this.options.logger.error("reconcile failed", {
          name: described.name,
          code: described.code,
        });
      }
      throw mapped;
    } finally {
      this.inFlight = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** Resolve when no reconcile is in flight. */
  waitForIdle(): Promise<void> {
    if (!this.inFlight) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }
}
