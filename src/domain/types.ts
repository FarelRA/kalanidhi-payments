import type { Payment, SessionState } from "merchantid";

export type ChargeStatus =
  "pending" | "paid" | "expired" | "failed" | "cancelled" | "refunded";

export interface ChargeRecord {
  chargeId: string;
  orderId: string;
  paymentId: string;
  baseAmount: number;
  uniqueAmount: number;
  description: string | null;
  status: ChargeStatus;
  providerReference: string | null;
  providerTransactionId: string | null;
  paidAt: number | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  failureCode: string | null;
  /** Never log this field. It is returned only to the authenticated caller. */
  qrString: string | null;
}

export interface ChargeTerminalPatch {
  status: ChargeStatus;
  providerReference?: string | null;
  providerTransactionId?: string | null;
  paidAt?: number | null;
  failureCode?: string | null;
}

export interface CreateChargeInput {
  orderId: string;
  baseAmount: number;
  expiresInSeconds?: number;
  description?: string;
}

export interface PaymentsCore {
  createPayment(input: {
    amount: number;
    reference?: string;
    expiresInMs?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Payment>;
  getPayment(id: string): Promise<Payment | undefined>;
  cancelPayment(id: string): Promise<Payment | undefined>;
  tick(): Promise<{ paid: Payment[]; expired: Payment[] }>;
  on(event: "paid", listener: (payment: Payment) => void): void;
  on(event: "expired", listener: (payment: Payment) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  hasSession(): boolean;
  /** Stop timers and release the store. */
  close?(): void;
}

export interface SessionGateway {
  requestOtp(phoneNumber: string): Promise<{ otpToken?: string }>;
  verifyOtp(input: {
    otp: string;
    otpToken: string;
    phoneNumber?: string;
  }): Promise<SessionState>;
  adoptSession(session: SessionState): void | Promise<void>;
  hasSession(): boolean;
  sessionExpiresAt(): number | undefined;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
