import type {
  MerchantTransaction,
  Payment,
  SessionState,
  TransactionFeed,
  TransactionFeedQuery,
  TransactionFeedResult,
} from "merchantid";
import { AmountAllocator, PaymentService } from "merchantid";
import { SqlitePaymentStore } from "merchantid/sqlite";

import type { PaymentsCore, SessionGateway } from "../../src/domain/types.js";

export class FakeFeed implements TransactionFeed {
  readonly transactions: MerchantTransaction[] = [];

  listRecent(_query: TransactionFeedQuery): Promise<TransactionFeedResult> {
    return Promise.resolve({
      transactions: [...this.transactions],
      pagesFetched: 1,
    });
  }

  queue(transaction: MerchantTransaction): MerchantTransaction {
    this.transactions.push(transaction);
    return transaction;
  }
}

export interface RealCoreOptions {
  path: string;
  merchantId: string;
  clockSkewMs: number;
  defaultExpiryMs: number;
  staticQris?: string;
}

/**
 * The real `merchantid` payment core with an in-memory transaction feed. Used
 * to exercise durable SQLite behavior without calling GoPay.
 */
export class RealCoreHarness implements PaymentsCore, SessionGateway {
  readonly store: SqlitePaymentStore;
  readonly service: PaymentService;
  readonly feed: FakeFeed;
  private readonly merchantId: string;
  private txSeq = 0;

  constructor(options: RealCoreOptions) {
    this.merchantId = options.merchantId;
    this.feed = new FakeFeed();
    this.store = new SqlitePaymentStore({
      path: options.path,
      busyTimeoutMs: 5_000,
      wal: true,
    });
    this.service = new PaymentService({
      merchantId: options.merchantId,
      scope: { provider: "gopay", merchantId: options.merchantId },
      store: this.store,
      transactionFeed: this.feed,
      ...(options.staticQris !== undefined
        ? { staticQris: options.staticQris }
        : {}),
      clockSkewMs: options.clockSkewMs,
      defaultExpiryMs: options.defaultExpiryMs,
      allocator: new AmountAllocator(999),
    });
  }

  createPayment(input: {
    amount: number;
    reference?: string;
    expiresInMs?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Payment> {
    return this.service.createPayment(input);
  }

  getPayment(id: string): Promise<Payment | undefined> {
    return this.service.getPayment(id);
  }

  cancelPayment(id: string): Promise<Payment | undefined> {
    return this.service.cancelPayment(id);
  }

  tick(): Promise<{ paid: Payment[]; expired: Payment[] }> {
    return this.service.tick();
  }

  on(event: "paid", listener: (payment: Payment) => void): void;
  on(event: "expired", listener: (payment: Payment) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "paid" | "expired" | "error",
    listener: ((payment: Payment) => void) | ((error: Error) => void),
  ): void {
    if (event === "paid") {
      this.service.on("paid", listener as (payment: Payment) => void);
    } else if (event === "expired") {
      this.service.on("expired", listener as (payment: Payment) => void);
    } else {
      this.service.on("error", listener as (error: Error) => void);
    }
  }

  hasSession(): boolean {
    return true;
  }

  sessionExpiresAt(): number | undefined {
    return undefined;
  }

  async requestOtp(_phoneNumber: string): Promise<{ otpToken?: string }> {
    throw new Error("Not supported by the test harness");
  }

  async verifyOtp(_input: {
    otp: string;
    otpToken: string;
    phoneNumber?: string;
  }): Promise<SessionState> {
    throw new Error("Not supported by the test harness");
  }

  adoptSession(_session: SessionState): void {
    // The harness does not persist sessions.
  }

  queueTransaction(
    uniqueAmount: number,
    overrides: Partial<MerchantTransaction> = {},
  ): MerchantTransaction {
    return this.feed.queue({
      id: `tx_real_${++this.txSeq}`,
      orderId: `QRIS-REAL-${this.txSeq}`,
      merchantId: this.merchantId,
      status: "SETTLEMENT",
      paymentType: "QRIS",
      grossAmount: uniqueAmount,
      currency: "IDR",
      transactionTime: new Date().toISOString(),
      raw: {},
      ...overrides,
    });
  }

  close(): void {
    this.service.stop();
    this.store.close();
  }
}
