import type { SessionManager, SessionStateStatus } from "./sessionManager.js";
import type { ReconcileRunner } from "./reconcileRunner.js";
import type { ChargeService } from "./chargeService.js";

export interface HealthPayload {
  status: "ok" | "degraded";
  version: string;
  uptimeSeconds: number;
  session: SessionStateStatus;
  pendingCharges: number;
  lastReconcileAt: string | null;
  lastReconcileDurationMs: number | null;
  lastReconcileFailedAt: string | null;
  reconcilerRunning: boolean;
}

export interface HealthServiceOptions {
  version: string;
  startedAt: number;
  session: SessionManager;
  charges: ChargeService;
  runner: ReconcileRunner;
  now?: () => number;
}

/** Health payload. Contains no tokens, keys, QRIS data, or file paths. */
export class HealthService {
  private readonly now: () => number;

  constructor(private readonly options: HealthServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  snapshot(): HealthPayload {
    const session = this.options.session.state();
    const last = this.options.runner.last();
    return {
      status: session === "valid" ? "ok" : "degraded",
      version: this.options.version,
      uptimeSeconds: Math.max(
        0,
        Math.floor((this.now() - this.options.startedAt) / 1_000),
      ),
      session,
      pendingCharges: this.options.charges.pendingCount(),
      lastReconcileAt: last?.completedAt ?? null,
      lastReconcileDurationMs: last?.durationMs ?? null,
      lastReconcileFailedAt: this.options.runner.lastFailure() ?? null,
      reconcilerRunning: this.options.runner.running,
    };
  }
}
