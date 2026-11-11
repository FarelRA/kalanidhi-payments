import type { DatabaseSync } from "node:sqlite";

import type {
  ChargeRecord,
  ChargeStatus,
  ChargeTerminalPatch,
} from "./types.js";

export type WebhookType =
  "payment.settled" | "payment.expired" | "payment.failed";

export type WebhookStatus = "pending" | "delivered" | "dead";

export interface WebhookOutboxRow {
  eventId: string;
  chargeId: string;
  type: WebhookType;
  payload: string;
  idempotencyKey: string;
  status: WebhookStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
}

export interface SessionRow {
  envelope: string;
  updatedAt: number;
}

interface ChargeRow {
  charge_id: string;
  order_id: string;
  payment_id: string;
  base_amount: number;
  unique_amount: number;
  description: string | null;
  status: string;
  provider_reference: string | null;
  provider_transaction_id: string | null;
  paid_at: number | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
  failure_code: string | null;
  qr_string: string | null;
}

interface WebhookRow {
  event_id: string;
  charge_id: string;
  type: string;
  payload: string;
  idempotency_key: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

function toCharge(row: ChargeRow): ChargeRecord {
  return {
    chargeId: row.charge_id,
    orderId: row.order_id,
    paymentId: row.payment_id,
    baseAmount: row.base_amount,
    uniqueAmount: row.unique_amount,
    description: row.description,
    status: row.status as ChargeStatus,
    providerReference: row.provider_reference,
    providerTransactionId: row.provider_transaction_id,
    paidAt: row.paid_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    failureCode: row.failure_code,
    qrString: row.qr_string,
  };
}

function toWebhook(row: WebhookRow): WebhookOutboxRow {
  return {
    eventId: row.event_id,
    chargeId: row.charge_id,
    type: row.type as WebhookType,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    status: row.status as WebhookStatus,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

/**
 * Synchronous SQLite repository for gateway-owned state.
 *
 * All methods are synchronous. Node's `node:sqlite` is synchronous, so a
 * single method is atomic with respect to other requests in this process.
 * Compare-and-set updates additionally protect the state machine.
 */
export class ChargeRepository {
  constructor(private readonly db: DatabaseSync) {}

  getById(chargeId: string): ChargeRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM gateway_charges WHERE charge_id = ?")
      .get(chargeId) as ChargeRow | undefined;
    return row ? toCharge(row) : undefined;
  }

  getByOrderId(orderId: string): ChargeRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM gateway_charges WHERE order_id = ?")
      .get(orderId) as ChargeRow | undefined;
    return row ? toCharge(row) : undefined;
  }

  getByPaymentId(paymentId: string): ChargeRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM gateway_charges WHERE payment_id = ?")
      .get(paymentId) as ChargeRow | undefined;
    return row ? toCharge(row) : undefined;
  }

  insert(charge: ChargeRecord): void {
    this.db
      .prepare(
        `INSERT INTO gateway_charges (
           charge_id, order_id, payment_id, base_amount, unique_amount,
           description, status, provider_reference, provider_transaction_id,
           paid_at, expires_at, created_at, updated_at, failure_code, qr_string
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        charge.chargeId,
        charge.orderId,
        charge.paymentId,
        charge.baseAmount,
        charge.uniqueAmount,
        charge.description,
        charge.status,
        charge.providerReference,
        charge.providerTransactionId,
        charge.paidAt,
        charge.expiresAt,
        charge.createdAt,
        charge.updatedAt,
        charge.failureCode,
        charge.qrString,
      );
  }

  /**
   * Atomically move a charge out of `expectedStatus`. Returns the updated row,
   * or `undefined` when the charge was already terminal (or missing).
   */
  transition(
    chargeId: string,
    expectedStatus: ChargeStatus,
    patch: ChargeTerminalPatch,
    updatedAt: number,
  ): ChargeRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE gateway_charges
            SET status = ?,
                provider_reference = ?,
                provider_transaction_id = ?,
                paid_at = ?,
                failure_code = ?,
                updated_at = ?
          WHERE charge_id = ? AND status = ?`,
      )
      .run(
        patch.status,
        patch.providerReference ?? null,
        patch.providerTransactionId ?? null,
        patch.paidAt ?? null,
        patch.failureCode ?? null,
        updatedAt,
        chargeId,
        expectedStatus,
      );
    if (Number(result.changes) === 0) return undefined;
    return this.getById(chargeId);
  }

  listByStatus(status: ChargeStatus, limit: number): ChargeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM gateway_charges
          WHERE status = ?
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(status, limit) as unknown as ChargeRow[];
    return rows.map(toCharge);
  }

  countByStatus(status: ChargeStatus): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM gateway_charges WHERE status = ?")
      .get(status) as { count: number };
    return Number(row.count);
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO gateway_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM gateway_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  saveSession(envelope: string, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO gateway_session (id, envelope, updated_at)
         VALUES ('gopay', ?, ?)
         ON CONFLICT(id) DO UPDATE
           SET envelope = excluded.envelope,
               updated_at = excluded.updated_at`,
      )
      .run(envelope, updatedAt);
  }

  loadSession(): SessionRow | undefined {
    const row = this.db
      .prepare(
        "SELECT envelope, updated_at FROM gateway_session WHERE id = 'gopay'",
      )
      .get() as { envelope: string; updated_at: number } | undefined;
    return row
      ? { envelope: row.envelope, updatedAt: row.updated_at }
      : undefined;
  }

  /** Insert a webhook event once. Returns false when it already existed. */
  insertWebhook(row: WebhookOutboxRow): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO gateway_webhook_outbox (
           event_id, charge_id, type, payload, idempotency_key, status,
           attempts, next_attempt_at, last_error, created_at, updated_at,
           delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(
        row.eventId,
        row.chargeId,
        row.type,
        row.payload,
        row.idempotencyKey,
        row.status,
        row.attempts,
        row.nextAttemptAt,
        row.lastError,
        row.createdAt,
        row.updatedAt,
        row.deliveredAt,
      );
    return Number(result.changes) > 0;
  }

  getWebhook(eventId: string): WebhookOutboxRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM gateway_webhook_outbox WHERE event_id = ?")
      .get(eventId) as WebhookRow | undefined;
    return row ? toWebhook(row) : undefined;
  }

  listDueWebhooks(at: number, limit: number): WebhookOutboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM gateway_webhook_outbox
          WHERE status = 'pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC, created_at ASC
          LIMIT ?`,
      )
      .all(at, limit) as unknown as WebhookRow[];
    return rows.map(toWebhook);
  }

  markWebhookDelivered(eventId: string, at: number): void {
    this.db
      .prepare(
        `UPDATE gateway_webhook_outbox
            SET status = 'delivered',
                attempts = attempts + 1,
                delivered_at = ?,
                updated_at = ?,
                last_error = NULL
          WHERE event_id = ?`,
      )
      .run(at, at, eventId);
  }

  markWebhookRetry(
    eventId: string,
    attempts: number,
    nextAttemptAt: number,
    lastError: string,
    at: number,
  ): void {
    this.db
      .prepare(
        `UPDATE gateway_webhook_outbox
            SET attempts = ?,
                next_attempt_at = ?,
                last_error = ?,
                updated_at = ?
          WHERE event_id = ? AND status = 'pending'`,
      )
      .run(attempts, nextAttemptAt, lastError, at, eventId);
  }

  markWebhookDead(
    eventId: string,
    attempts: number,
    lastError: string,
    at: number,
  ): void {
    this.db
      .prepare(
        `UPDATE gateway_webhook_outbox
            SET status = 'dead',
                attempts = ?,
                last_error = ?,
                updated_at = ?
          WHERE event_id = ?`,
      )
      .run(attempts, lastError, at, eventId);
  }
}
