import { randomUUID } from "node:crypto";

import type { Payment } from "merchantid";

import type { AppLogger } from "../logger.js";
import { AppError, SessionUnavailableError, describeError } from "../errors.js";
import { mapCoreError } from "./coreErrors.js";
import type { ChargeRepository } from "./repository.js";
import { SerialQueue } from "./serialQueue.js";
import type { ChargeRecord, CreateChargeInput, PaymentsCore } from "./types.js";
import type { WebhookOutbox } from "./webhook.js";

export interface ChargeServiceOptions {
  core: PaymentsCore;
  repo: ChargeRepository;
  webhook: WebhookOutbox;
  logger: AppLogger;
  defaultExpirySeconds: number;
  now?: () => number;
  newChargeId?: () => string;
}

export interface CreateChargeResult {
  charge: ChargeRecord;
  created: boolean;
}

function newChargeId(): string {
  return `ch_${randomUUID().replaceAll("-", "")}`;
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
  );
}

function transactionTimeMs(payment: Payment): number | undefined {
  const candidates = [
    payment.transaction?.settlementTime,
    payment.transaction?.transactionTime,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Charge lifecycle: order-id idempotency, unique amounts, cancellation,
 * settlement/expiry bookkeeping, and webhook enqueueing.
 *
 * The `merchantid` store is the money-path source of truth. This service keeps
 * a durable index of charges and reconciles its status from core transitions,
 * so a crash between the core write and the index write is repaired on the next
 * reconcile.
 */
export class ChargeService {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly creates = new SerialQueue();

  constructor(private readonly options: ChargeServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newChargeId ?? newChargeId;

    options.core.on("paid", (payment) => {
      this.applyCorePayment(payment);
    });
    options.core.on("expired", (payment) => {
      this.applyCorePayment(payment);
    });
    options.core.on("error", (error) => {
      const described = describeError(error);
      options.logger.error("payment core error", {
        name: described.name,
        code: described.code,
      });
    });
  }

  async create(input: CreateChargeInput): Promise<CreateChargeResult> {
    return this.creates.run(async () => {
      const existing = this.options.repo.getByOrderId(input.orderId);
      if (existing) {
        return this.resolveExisting(existing, input.baseAmount);
      }
      if (!this.options.core.hasSession()) {
        throw new SessionUnavailableError();
      }

      const expiresInSeconds =
        input.expiresInSeconds ?? this.options.defaultExpirySeconds;
      let payment: Payment;
      try {
        payment = await this.options.core.createPayment({
          amount: input.baseAmount,
          reference: input.orderId,
          expiresInMs: expiresInSeconds * 1_000,
        });
      } catch (error) {
        const described = describeError(error);
        this.options.logger.error("charge creation failed in payment core", {
          orderId: input.orderId,
          name: described.name,
          code: described.code,
        });
        throw mapCoreError(error);
      }

      const current = this.now();
      const charge: ChargeRecord = {
        chargeId: this.newId(),
        orderId: input.orderId,
        paymentId: payment.id,
        baseAmount: payment.baseAmount,
        uniqueAmount: payment.uniqueAmount,
        description: input.description?.trim() || null,
        status: "pending",
        providerReference: null,
        providerTransactionId: null,
        paidAt: null,
        expiresAt: payment.expiresAt,
        createdAt: current,
        updatedAt: current,
        failureCode: null,
        qrString: payment.qrString ?? null,
      };

      try {
        this.options.repo.insert(charge);
      } catch (error) {
        // Any persistence failure must not leak a pending amount. Cancel the
        // orphan payment; on a UNIQUE order-id race, return the winner.
        await this.options.core
          .cancelPayment(payment.id)
          .catch((cancelError) => {
            const described = describeError(cancelError);
            this.options.logger.error("failed to cancel orphan payment", {
              paymentId: payment.id,
              name: described.name,
              code: described.code,
            });
          });
        if (isUniqueConstraint(error)) {
          const raced = this.options.repo.getByOrderId(input.orderId);
          if (raced) return this.resolveExisting(raced, input.baseAmount);
        }
        const described = describeError(error);
        this.options.logger.error("failed to persist charge", {
          orderId: input.orderId,
          paymentId: payment.id,
          name: described.name,
          code: described.code,
        });
        throw new AppError(
          500,
          "CHARGE_PERSIST_FAILED",
          "Unable to persist the charge.",
        );
      }

      this.options.logger.info("charge created", {
        chargeId: charge.chargeId,
        orderId: charge.orderId,
        baseAmount: charge.baseAmount,
        uniqueAmount: charge.uniqueAmount,
        expiresAt: new Date(charge.expiresAt).toISOString(),
      });
      return { charge, created: true };
    });
  }

  private resolveExisting(
    existing: ChargeRecord,
    baseAmount: number,
  ): CreateChargeResult {
    if (existing.baseAmount !== baseAmount) {
      throw new AppError(
        409,
        "ORDER_AMOUNT_MISMATCH",
        "This order already has a charge with a different base amount.",
        { orderId: existing.orderId },
      );
    }
    if (existing.status === "pending" || existing.status === "paid") {
      return { charge: existing, created: false };
    }
    throw new AppError(
      409,
      "ORDER_NOT_REUSABLE",
      "This order's charge is terminal; use a new order id.",
      { status: existing.status },
    );
  }

  get(chargeId: string): ChargeRecord {
    const charge = this.options.repo.getById(chargeId);
    if (!charge) {
      throw new AppError(404, "CHARGE_NOT_FOUND", "Charge not found.");
    }
    return charge;
  }

  async cancel(chargeId: string): Promise<ChargeRecord> {
    const charge = this.get(chargeId);
    if (charge.status !== "pending") {
      throw new AppError(
        409,
        "CHARGE_NOT_PENDING",
        "Only a pending charge can be cancelled.",
        { status: charge.status },
      );
    }
    if (!this.options.core.hasSession()) {
      throw new SessionUnavailableError();
    }

    let payment: Payment | undefined;
    try {
      payment = await this.options.core.cancelPayment(charge.paymentId);
    } catch (error) {
      const described = describeError(error);
      this.options.logger.error("charge cancellation failed in payment core", {
        chargeId,
        name: described.name,
        code: described.code,
      });
      throw mapCoreError(error);
    }
    if (!payment) {
      throw new AppError(404, "CHARGE_NOT_FOUND", "Charge not found.");
    }

    const updated = this.applyCorePayment(payment, charge);
    if (!updated) {
      throw new AppError(404, "CHARGE_NOT_FOUND", "Charge not found.");
    }
    if (updated.status === "cancelled") {
      this.options.logger.info("charge cancelled", { chargeId });
      return updated;
    }
    // Settlement won the race with cancellation.
    throw new AppError(
      409,
      "CHARGE_NOT_PENDING",
      "The charge left pending before it could be cancelled.",
      { status: updated.status },
    );
  }

  /**
   * Apply a core state to the charge index. Safe to call repeatedly; webhook
   * enqueueing is idempotent by stable event id.
   */
  applyCorePayment(
    payment: Payment,
    knownCharge?: ChargeRecord,
  ): ChargeRecord | undefined {
    const charge = knownCharge ?? this.options.repo.getByPaymentId(payment.id);
    if (!charge) {
      this.options.logger.warn("payment core transition has no charge", {
        paymentId: payment.id,
        status: payment.status,
      });
      return undefined;
    }
    if (payment.uniqueAmount !== charge.uniqueAmount) {
      this.options.logger.error("charge amount does not match core payment", {
        chargeId: charge.chargeId,
        paymentId: payment.id,
      });
      return charge;
    }

    if (payment.status === "pending") {
      return charge;
    }

    if (charge.status !== "pending") {
      // Heal a missing outbox row for an already-terminal charge.
      if (payment.status === "paid" && charge.status === "paid") {
        this.options.webhook.enqueueSettled(
          charge,
          payment,
          charge.paidAt ?? this.now(),
        );
      } else if (payment.status === "expired" && charge.status === "expired") {
        this.options.webhook.enqueueExpired(charge, payment);
      }
      return charge;
    }

    const current = this.now();
    if (payment.status === "paid") {
      const transactionId = payment.transaction?.id ?? null;
      const paidAt = transactionTimeMs(payment) ?? current;
      const updated = this.options.repo.transition(
        charge.chargeId,
        "pending",
        {
          status: "paid",
          providerReference: transactionId,
          providerTransactionId: transactionId,
          paidAt,
          failureCode: null,
        },
        current,
      );
      if (!updated) return this.options.repo.getById(charge.chargeId);
      this.options.webhook.enqueueSettled(updated, payment, paidAt);
      this.options.logger.info("charge settled", {
        chargeId: updated.chargeId,
        orderId: updated.orderId,
        providerTransactionId: transactionId,
        amount: updated.uniqueAmount,
      });
      return updated;
    }

    if (payment.status === "expired") {
      const updated = this.options.repo.transition(
        charge.chargeId,
        "pending",
        {
          status: "expired",
          providerReference: null,
          providerTransactionId: null,
          paidAt: null,
          failureCode: null,
        },
        current,
      );
      if (!updated) return this.options.repo.getById(charge.chargeId);
      this.options.webhook.enqueueExpired(updated, payment);
      this.options.logger.info("charge expired", {
        chargeId: updated.chargeId,
        orderId: updated.orderId,
      });
      return updated;
    }

    // cancelled
    const updated = this.options.repo.transition(
      charge.chargeId,
      "pending",
      {
        status: "cancelled",
        providerReference: null,
        providerTransactionId: null,
        paidAt: null,
        failureCode: null,
      },
      current,
    );
    return updated ?? this.options.repo.getById(charge.chargeId);
  }

  /**
   * Repair the local index from the durable core store. No upstream polling:
   * `getPayment` only reads SQLite.
   */
  async syncPendingStatuses(limit = 500): Promise<void> {
    for (const charge of this.options.repo.listByStatus("pending", limit)) {
      let payment: Payment | undefined;
      try {
        payment = await this.options.core.getPayment(charge.paymentId);
      } catch (error) {
        const described = describeError(error);
        this.options.logger.warn("unable to read core payment during sync", {
          chargeId: charge.chargeId,
          name: described.name,
          code: described.code,
        });
        return;
      }
      if (!payment) {
        this.options.logger.error("pending charge has no core payment", {
          chargeId: charge.chargeId,
          paymentId: charge.paymentId,
        });
        continue;
      }
      this.applyCorePayment(payment, charge);
    }
  }

  /**
   * Application-level failure (for example an operator rejecting an unpaid
   * order). Not wired to a public route in v1.
   *
   * The pending provider payment is cancelled first so a later transfer cannot
   * settle an order the application already failed.
   */
  async markFailed(
    chargeId: string,
    reasonCode: string,
  ): Promise<ChargeRecord> {
    const charge = this.get(chargeId);
    if (charge.status !== "pending") return charge;
    if (!this.options.core.hasSession()) {
      throw new SessionUnavailableError();
    }

    let payment: Payment | undefined;
    try {
      payment = await this.options.core.cancelPayment(charge.paymentId);
    } catch (error) {
      throw mapCoreError(error);
    }
    if (!payment) {
      throw new AppError(404, "CHARGE_NOT_FOUND", "Charge not found.");
    }
    if (payment.status !== "cancelled") {
      const applied = this.applyCorePayment(payment, charge);
      throw new AppError(
        409,
        "CHARGE_NOT_PENDING",
        "The charge left pending before it could be failed.",
        { status: applied?.status ?? payment.status },
      );
    }

    const updated = this.options.repo.transition(
      charge.chargeId,
      "pending",
      {
        status: "failed",
        providerReference: null,
        providerTransactionId: null,
        paidAt: null,
        failureCode: reasonCode,
      },
      this.now(),
    );
    if (!updated) return this.options.repo.getById(charge.chargeId) ?? charge;
    this.options.webhook.enqueueFailed(updated, reasonCode);
    this.options.logger.warn("charge marked failed", {
      chargeId,
      reasonCode,
    });
    return updated;
  }

  async deliverWebhooks(limit = 20): Promise<{
    delivered: number;
    retrying: number;
    dead: number;
  }> {
    return this.options.webhook.processDue(limit);
  }

  pendingCount(): number {
    return this.options.repo.countByStatus("pending");
  }
}
