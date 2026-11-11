import type { Payment, SessionState } from "merchantid";
import { AuthError, MerchantIdError } from "merchantid";

import type { PaymentsCore, SessionGateway } from "../../src/domain/types.js";

const SETTLEABLE = new Set([
  "settlement",
  "settle",
  "settled",
  "capture",
  "captured",
  "success",
  "succeeded",
  "paid",
  "completed",
  "complete",
]);

export interface FakeCoreOptions {
  now: () => number;
  merchantId?: string;
  clockSkewMs?: number;
  maxOffset?: number;
  sessionPresent?: boolean;
}

interface QueuedTransaction {
  id: string;
  orderId: string;
  merchantId: string;
  status: string;
  paymentType: string;
  grossAmount: number;
  currency: string;
  transactionTime: string;
  settlementTime?: string;
  raw: unknown;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory provider used by unit/integration tests. Never calls GoPay. */
export class FakePaymentsCore implements PaymentsCore, SessionGateway {
  readonly merchantId: string;
  readonly payments = new Map<string, Payment>();
  readonly transactions: QueuedTransaction[] = [];
  readonly consumed = new Set<string>();

  createCount = 0;
  tickCalls = 0;
  getPaymentCalls = 0;
  lastPhone: string | undefined;
  lastOtp: string | undefined;
  maxOffset: number;
  failedOtp = false;
  tickGate: Promise<void> | undefined;

  private session: SessionState | undefined;
  private sessionPresent: boolean;
  private seq = 0;
  private txSeq = 0;
  private readonly now: () => number;
  private readonly clockSkewMs: number;
  private readonly paidListeners = new Set<(payment: Payment) => void>();
  private readonly expiredListeners = new Set<(payment: Payment) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  constructor(options: FakeCoreOptions) {
    this.now = options.now;
    this.merchantId = options.merchantId ?? "G000000001";
    this.clockSkewMs = options.clockSkewMs ?? 0;
    this.maxOffset = options.maxOffset ?? 999;
    this.sessionPresent = options.sessionPresent ?? true;
    if (this.sessionPresent) {
      this.session = {
        tokens: {
          accessToken: "fake-access-token-do-not-log",
          refreshToken: "fake-refresh-token-do-not-log",
          tokenType: "Bearer",
          expiresAt: this.now() + 3_600_000,
        },
        deviceId: "fake-device-id",
      };
    }
  }

  setSessionMissing(): void {
    this.sessionPresent = false;
    this.session = undefined;
  }

  adoptSession(session: SessionState): void {
    this.session = session;
    this.sessionPresent = true;
  }

  hasSession(): boolean {
    return this.sessionPresent && this.session !== undefined;
  }

  sessionExpiresAt(): number | undefined {
    return this.session?.tokens.expiresAt;
  }

  async requestOtp(phoneNumber: string): Promise<{ otpToken?: string }> {
    this.lastPhone = phoneNumber;
    return { otpToken: `otp-token-${++this.seq}` };
  }

  async verifyOtp(input: {
    otp: string;
    otpToken: string;
    phoneNumber?: string;
  }): Promise<SessionState> {
    this.lastOtp = input.otp;
    if (this.failedOtp || input.otp !== "123456") {
      throw new AuthError("AUTH_FAILED", "Invalid OTP");
    }
    return {
      tokens: {
        accessToken: "fake-access-token-do-not-log",
        refreshToken: "fake-refresh-token-do-not-log",
        tokenType: "Bearer",
        expiresAt: this.now() + 3_600_000,
      },
      deviceId: "fake-device-id",
      lastRefreshedAt: this.now(),
    };
  }

  async createPayment(input: {
    amount: number;
    reference?: string;
    expiresInMs?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Payment> {
    if (!this.hasSession()) {
      throw new AuthError("AUTH_REQUIRED", "No session");
    }
    this.createCount += 1;

    const taken = new Set(
      [...this.payments.values()]
        .filter((payment) => payment.status === "pending")
        .map((payment) => payment.uniqueAmount),
    );
    let offset = 0;
    for (let candidate = 1; candidate <= this.maxOffset; candidate += 1) {
      if (!taken.has(input.amount + candidate)) {
        offset = candidate;
        break;
      }
    }
    if (offset === 0) {
      throw new MerchantIdError(
        "AMOUNT_POOL_EXHAUSTED",
        "No unique amount available",
      );
    }

    const createdAt = this.now();
    const payment: Payment = {
      id: `pay_fake_${++this.seq}`,
      scope: { provider: "gopay", merchantId: this.merchantId },
      baseAmount: input.amount,
      uniqueOffset: offset,
      uniqueAmount: input.amount + offset,
      status: "pending",
      createdAt,
      expiresAt: createdAt + (input.expiresInMs ?? 600_000),
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      qrString: `FAKE-QRIS-${input.amount + offset}`,
    };
    this.payments.set(payment.id, payment);
    return clone(payment);
  }

  async getPayment(id: string): Promise<Payment | undefined> {
    this.getPaymentCalls += 1;
    const payment = this.payments.get(id);
    return payment ? clone(payment) : undefined;
  }

  async cancelPayment(id: string): Promise<Payment | undefined> {
    const payment = this.payments.get(id);
    if (!payment) return undefined;
    if (payment.status === "pending") {
      payment.status = "cancelled";
    }
    return clone(payment);
  }

  async tick(): Promise<{ paid: Payment[]; expired: Payment[] }> {
    this.tickCalls += 1;
    if (this.tickGate) await this.tickGate;

    const paid: Payment[] = [];
    const expired: Payment[] = [];
    const pending = [...this.payments.values()]
      .filter((payment) => payment.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    for (const payment of pending) {
      const transaction = this.transactions.find((candidate) => {
        if (this.consumed.has(candidate.id)) return false;
        if (candidate.grossAmount !== payment.uniqueAmount) return false;
        if (!SETTLEABLE.has(candidate.status.trim().toLowerCase()))
          return false;
        const time = Date.parse(candidate.transactionTime);
        if (!Number.isFinite(time)) return false;
        return (
          time >= payment.createdAt - this.clockSkewMs &&
          time <= payment.expiresAt + this.clockSkewMs
        );
      });
      if (!transaction) continue;
      this.consumed.add(transaction.id);
      payment.status = "paid";
      payment.transaction = {
        ...transaction,
        transactionTime: transaction.transactionTime,
      };
      paid.push(clone(payment));
      this.emitPaid(clone(payment));
    }

    const current = this.now();
    for (const payment of pending) {
      if (payment.status !== "pending") continue;
      if (payment.expiresAt + this.clockSkewMs > current) continue;
      payment.status = "expired";
      expired.push(clone(payment));
      this.emitExpired(clone(payment));
    }

    return { paid, expired };
  }

  queueTransaction(
    uniqueAmount: number,
    overrides: Partial<QueuedTransaction> = {},
  ): QueuedTransaction {
    const transaction: QueuedTransaction = {
      id: `tx_fake_${++this.txSeq}`,
      orderId: `QRIS-${this.txSeq}`,
      merchantId: this.merchantId,
      status: "SETTLEMENT",
      paymentType: "QRIS",
      grossAmount: uniqueAmount,
      currency: "IDR",
      transactionTime: new Date(this.now()).toISOString(),
      raw: {},
      ...overrides,
    };
    this.transactions.push(transaction);
    return transaction;
  }

  /** Mutate core state without emitting a lifecycle event. */
  forceStatus(
    paymentId: string,
    status: Payment["status"],
    transaction?: Payment["transaction"],
  ): void {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error(`Unknown fake payment ${paymentId}`);
    payment.status = status;
    if (transaction) payment.transaction = transaction;
  }

  on(event: "paid", listener: (payment: Payment) => void): void;
  on(event: "expired", listener: (payment: Payment) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "paid" | "expired" | "error",
    listener: ((payment: Payment) => void) | ((error: Error) => void),
  ): void {
    if (event === "paid") {
      this.paidListeners.add(listener as (payment: Payment) => void);
    } else if (event === "expired") {
      this.expiredListeners.add(listener as (payment: Payment) => void);
    } else {
      this.errorListeners.add(listener as (error: Error) => void);
    }
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  private emitPaid(payment: Payment): void {
    for (const listener of this.paidListeners) listener(payment);
  }

  private emitExpired(payment: Payment): void {
    for (const listener of this.expiredListeners) listener(payment);
  }
}
