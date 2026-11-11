import { randomUUID } from "node:crypto";

import {
  GopayProvider,
  type Payment,
  type SessionState,
  type PaymentService,
} from "merchantid";
import type { SqlitePaymentStore } from "merchantid/sqlite";

import type { AppLogger } from "../logger.js";
import { SessionUnavailableError } from "../errors.js";
import { createSafeCoreLogger } from "./safeCoreLogger.js";
import type { PaymentsCore, SessionGateway } from "./types.js";

export interface GopayPaymentsCoreOptions {
  merchantId: string;
  staticQris: string;
  store: SqlitePaymentStore;
  clockSkewMs: number;
  defaultExpiryMs: number;
  maxUniqueOffset: number;
  requestTimeoutMs?: number;
  logger: AppLogger;
  /** Persist a rotated session. Called before the new token is used. */
  onSessionRefreshed: (session: SessionState) => Promise<void>;
  initialSession?: SessionState;
}

/**
 * Adapter from the hardened `merchantid` GoPay provider to the gateway's small
 * `PaymentsCore` / `SessionGateway` ports.
 *
 * `GopayProvider.payments()` requires an authenticated session. The adapter
 * therefore refuses to create or reconcile charges until OTP login succeeds,
 * matching the design contract (`session_expired` pauses QR generation).
 * OTP verification runs on a throwaway provider so the session is persisted to
 * the vault before the main provider adopts it.
 */
export class GopayPaymentsCore implements PaymentsCore, SessionGateway {
  private provider: GopayProvider;
  private service?: PaymentService;
  private session?: SessionState;
  private readonly paidListeners = new Set<(payment: Payment) => void>();
  private readonly expiredListeners = new Set<(payment: Payment) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly deviceId: string;
  private closed = false;

  constructor(private readonly options: GopayPaymentsCoreOptions) {
    this.session = options.initialSession;
    this.deviceId = options.initialSession?.deviceId ?? randomUUID();
    this.provider = this.buildProvider(options.initialSession);
  }

  private buildProvider(session?: SessionState): GopayProvider {
    return new GopayProvider({
      merchantId: this.options.merchantId,
      staticQris: this.options.staticQris,
      session,
      deviceId: this.deviceId,
      store: this.options.store,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 15_000,
      payment: {
        defaultExpiryMs: this.options.defaultExpiryMs,
        clockSkewMs: this.options.clockSkewMs,
        maxUniqueOffset: this.options.maxUniqueOffset,
      },
      onTokenRefreshed: async (refreshed) => {
        await this.options.onSessionRefreshed(refreshed);
        this.session = refreshed;
      },
      logger: createSafeCoreLogger(this.options.logger),
    });
  }

  /**
   * Persist-before-use session swap. Called by `SessionManager` only after the
   * vault write succeeded.
   */
  adoptSession(session: SessionState): void {
    if (this.closed) throw new Error("Payments core is closed");
    this.service?.stop();
    this.service = undefined;
    this.session = session;
    this.provider = this.buildProvider(session);
  }

  hasSession(): boolean {
    return this.provider.authenticated;
  }

  sessionExpiresAt(): number | undefined {
    return this.session?.tokens.expiresAt;
  }

  async requestOtp(phoneNumber: string): Promise<{ otpToken?: string }> {
    const result = await this.provider.requestOtp(phoneNumber);
    return result.otpToken ? { otpToken: result.otpToken } : {};
  }

  async verifyOtp(input: {
    otp: string;
    otpToken: string;
    phoneNumber?: string;
  }): Promise<SessionState> {
    // A separate provider keeps the live provider untouched until the vault
    // write succeeds. It shares the SQLite store but performs auth only.
    const scratch = this.buildProvider(undefined);
    await scratch.verifyOtp(input);
    return scratch.exportSession();
  }

  private payments(): PaymentService {
    if (!this.provider.authenticated) {
      throw new SessionUnavailableError();
    }
    if (!this.service) {
      this.service = this.provider.payments();
      for (const listener of this.paidListeners) {
        this.service.on("paid", listener);
      }
      for (const listener of this.expiredListeners) {
        this.service.on("expired", listener);
      }
      for (const listener of this.errorListeners) {
        this.service.on("error", listener);
      }
    }
    return this.service;
  }

  createPayment(input: {
    amount: number;
    reference?: string;
    expiresInMs?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Payment> {
    return this.payments().createPayment(input);
  }

  getPayment(id: string): Promise<Payment | undefined> {
    return this.payments().getPayment(id);
  }

  cancelPayment(id: string): Promise<Payment | undefined> {
    return this.payments().cancelPayment(id);
  }

  tick(): Promise<{ paid: Payment[]; expired: Payment[] }> {
    return this.payments().tick();
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
      this.service?.on("paid", listener as (payment: Payment) => void);
      return;
    }
    if (event === "expired") {
      this.expiredListeners.add(listener as (payment: Payment) => void);
      this.service?.on("expired", listener as (payment: Payment) => void);
      return;
    }
    this.errorListeners.add(listener as (error: Error) => void);
    this.service?.on("error", listener as (error: Error) => void);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.service?.stop();
    this.service = undefined;
    this.options.store.close();
  }
}
