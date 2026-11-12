import type { Payment } from "merchantid";
import { jitteredBackoff } from "merchantid";
import {
  createPaymentWebhookEvent,
  deliverWebhook,
  signWebhook,
  WebhookSecurityError,
  type WebhookDeliveryOptions,
  type WebhookDeliveryResult,
  type WebhookEvent,
  type WebhookEventType,
} from "merchantid/webhook";

import type { WebhookConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { ChargeRecord } from "./types.js";
import type {
  ChargeRepository,
  WebhookOutboxRow,
  WebhookType,
} from "./repository.js";

export interface WireWebhookEvent {
  /** Library-native fields. */
  id: string;
  type: WebhookEventType;
  createdAt: string;
  data: unknown;
  /** KalaNidhi contract fields (docs/payments-gateway.md section 7). */
  event: WebhookEventType;
  eventId: string;
  chargeId: string;
  orderId: string;
  providerTransactionId: string | null;
  amount: number;
  paidAt: string | null;
  /** Provider fee in whole rupiah when the feed reports it. */
  gatewayFee?: number;
}

export interface WebhookDeliverySummary {
  delivered: number;
  retrying: number;
  dead: number;
}

export interface WebhookOutboxOptions {
  repo: ChargeRepository;
  config: WebhookConfig;
  logger: AppLogger;
  now?: () => number;
  random?: () => number;
  /** Test seam; defaults to the library's SSRF-checked delivery. */
  deliver?: (options: WebhookDeliveryOptions) => Promise<WebhookDeliveryResult>;
  /** Test seam; production must leave DNS resolution enabled. */
  resolveDns?: boolean;
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

const FEE_KEYS = [
  "mdr",
  "fee",
  "merchant_fee",
  "service_fee",
  "admin_fee",
  "total_fee",
  "fee_amount",
  "net_fee",
  "deduction",
  "biaya",
] as const;

function wholeRupiah(value: unknown, ceiling: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const candidates = value > ceiling ? [Math.round(value / 100)] : [Math.round(value)];
  return candidates.find(
    (candidate) =>
      Number.isInteger(candidate) && candidate > 0 && candidate <= ceiling,
  );
}

/**
 * Best-effort provider fee. GoBiz reports amounts in sen, so a raw fee larger
 * than the payment is normalized once. When the feed exposes no fee, the
 * webhook omits the field and the operator records the real MDR later.
 */
export function extractGatewayFee(payment: Payment): number | undefined {
  const ceiling = payment.uniqueAmount;
  const raw = payment.transaction?.raw;
  if (raw && typeof raw === "object") {
    for (const key of FEE_KEYS) {
      const fee = wholeRupiah((raw as Record<string, unknown>)[key], ceiling);
      if (fee !== undefined) return fee;
    }
  }
  const real = payment.transaction?.realGrossAmount;
  if (typeof real === "number" && real > 0 && real < ceiling) {
    return ceiling - real;
  }
  return undefined;
}

function parseTransactionTime(payment: Payment): number | undefined {
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
 * Durable webhook outbox.
 *
 * The library signs and delivers one attempt at a time (`maxAttempts: 1`).
 * Attempt counting, exponential backoff and dead-lettering live here so they
 * survive a restart. The event id and idempotency key are stable across every
 * attempt and both are derived from `(chargeId, eventType)`.
 */
export class WebhookOutbox {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly deliver: (
    options: WebhookDeliveryOptions,
  ) => Promise<WebhookDeliveryResult>;
  private readonly resolveDns: boolean;
  private delivering = false;

  constructor(private readonly options: WebhookOutboxOptions) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.deliver = options.deliver ?? deliverWebhook;
    this.resolveDns = options.resolveDns ?? true;
  }

  private insert(event: WireWebhookEvent): boolean {
    const current = this.now();
    const row: WebhookOutboxRow = {
      eventId: event.eventId,
      chargeId: event.chargeId,
      type: event.event as WebhookType,
      payload: JSON.stringify(event),
      idempotencyKey: event.eventId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: current,
      lastError: null,
      createdAt: current,
      updatedAt: current,
      deliveredAt: null,
    };
    return this.options.repo.insertWebhook(row);
  }

  enqueueSettled(charge: ChargeRecord, payment: Payment, paidAt: number): void {
    const base = createPaymentWebhookEvent("payment.settled", payment, {
      id: `${charge.chargeId}:payment.settled`,
    });
    this.insert({
      ...base,
      event: base.type,
      eventId: base.id,
      chargeId: charge.chargeId,
      orderId: charge.orderId,
      providerTransactionId: payment.transaction?.id ?? null,
      amount: payment.uniqueAmount,
      paidAt: iso(parseTransactionTime(payment) ?? paidAt),
      gatewayFee: extractGatewayFee(payment),
    });
  }

  enqueueExpired(charge: ChargeRecord, payment: Payment): void {
    const base = createPaymentWebhookEvent("payment.expired", payment, {
      id: `${charge.chargeId}:payment.expired`,
    });
    this.insert({
      ...base,
      event: base.type,
      eventId: base.id,
      chargeId: charge.chargeId,
      orderId: charge.orderId,
      providerTransactionId: payment.transaction?.id ?? null,
      amount: payment.uniqueAmount,
      paidAt: null,
    });
  }

  /**
   * Application-level failure only. `merchantid` has no failed payment status,
   * so this event is built here rather than from a settlement transition.
   */
  enqueueFailed(charge: ChargeRecord, reasonCode: string): void {
    const current = this.now();
    const eventId = `${charge.chargeId}:payment.failed`;
    const event: WebhookEvent<unknown> = {
      id: eventId,
      type: "payment.failed",
      createdAt: iso(current),
      data: {
        chargeId: charge.chargeId,
        orderId: charge.orderId,
        status: "failed",
        reasonCode,
        baseAmount: charge.baseAmount,
        uniqueAmount: charge.uniqueAmount,
        expiresAt: iso(charge.expiresAt),
      },
    };
    this.insert({
      ...event,
      event: event.type,
      eventId,
      chargeId: charge.chargeId,
      orderId: charge.orderId,
      providerTransactionId: null,
      amount: charge.uniqueAmount,
      paidAt: null,
    });
  }

  /** Deliver due events once each. Never throws for a delivery failure. */
  async processDue(limit = 20): Promise<WebhookDeliverySummary> {
    if (this.delivering) {
      return { delivered: 0, retrying: 0, dead: 0 };
    }
    this.delivering = true;
    try {
      return await this.processDueUnsafe(limit);
    } finally {
      this.delivering = false;
    }
  }

  private async processDueUnsafe(
    limit: number,
  ): Promise<WebhookDeliverySummary> {
    const current = this.now();
    const due = this.options.repo.listDueWebhooks(current, limit);
    const summary: WebhookDeliverySummary = {
      delivered: 0,
      retrying: 0,
      dead: 0,
    };

    for (const row of due) {
      let event: WireWebhookEvent;
      try {
        event = JSON.parse(row.payload) as WireWebhookEvent;
      } catch {
        this.options.repo.markWebhookDead(
          row.eventId,
          row.attempts + 1,
          "INVALID_PAYLOAD",
          this.now(),
        );
        summary.dead += 1;
        this.options.logger.error("webhook payload was not valid JSON", {
          eventId: row.eventId,
          chargeId: row.chargeId,
          type: row.type,
        });
        continue;
      }

      const attemptAt = this.now();
      const timestamp = Math.floor(attemptAt / 1_000);
      const body = JSON.stringify(event);
      const headers: Record<string, string> = {
        "x-kalanidhi-event": row.type,
        "x-kalanidhi-event-id": row.eventId,
        "x-kalanidhi-timestamp": String(timestamp),
        "x-kalanidhi-signature": `sha256=${signWebhook(
          this.options.config.secret,
          timestamp,
          body,
        )}`,
      };

      let result: WebhookDeliveryResult;
      try {
        result = await this.deliver({
          url: this.options.config.url,
          secret: this.options.config.secret,
          event,
          idempotencyKey: row.idempotencyKey,
          maxAttempts: 1,
          timeoutMs: this.options.config.timeoutMs,
          allowHttp: this.options.config.allowHttp,
          allowPrivateNetworks: this.options.config.allowPrivateNetworks,
          resolveDns: this.resolveDns,
          headers,
          now: this.now,
        });
      } catch (error) {
        // URL validation and configuration errors are not retryable.
        const code =
          error instanceof WebhookSecurityError
            ? `WEBHOOK_SECURITY_${error.code}`
            : "WEBHOOK_DELIVERY_ERROR";
        this.options.repo.markWebhookDead(
          row.eventId,
          row.attempts + 1,
          code,
          this.now(),
        );
        summary.dead += 1;
        this.options.logger.error("webhook dead-lettered", {
          eventId: row.eventId,
          chargeId: row.chargeId,
          type: row.type,
          attempts: row.attempts + 1,
          code,
        });
        continue;
      }

      if (result.ok) {
        this.options.repo.markWebhookDelivered(row.eventId, this.now());
        summary.delivered += 1;
        this.options.logger.info("webhook delivered", {
          eventId: row.eventId,
          chargeId: row.chargeId,
          type: row.type,
          attempt: row.attempts + 1,
          status: result.status,
        });
        continue;
      }

      const attempts = row.attempts + 1;
      const code = result.error?.code ?? "UNKNOWN";
      const detail = `${code}${result.status ? `:${result.status}` : ""}`;
      if (attempts >= this.options.config.maxAttempts) {
        this.options.repo.markWebhookDead(
          row.eventId,
          attempts,
          detail,
          this.now(),
        );
        summary.dead += 1;
        this.options.logger.error("webhook dead-lettered", {
          eventId: row.eventId,
          chargeId: row.chargeId,
          type: row.type,
          attempts,
          code,
          status: result.status,
        });
        continue;
      }

      const delay = jitteredBackoff(row.attempts, {
        baseMs: this.options.config.baseDelayMs,
        maxMs: this.options.config.maxDelayMs,
        jitterRatio: 0.2,
        random: this.random,
      });
      this.options.repo.markWebhookRetry(
        row.eventId,
        attempts,
        this.now() + delay,
        detail,
        this.now(),
      );
      summary.retrying += 1;
      this.options.logger.warn("webhook delivery failed; retry scheduled", {
        eventId: row.eventId,
        chargeId: row.chargeId,
        type: row.type,
        attempts,
        code,
        status: result.status,
      });
    }

    return summary;
  }
}
