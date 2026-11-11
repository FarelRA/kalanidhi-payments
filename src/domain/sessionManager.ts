import type { SessionState } from "merchantid";

import type { AppLogger } from "../logger.js";
import { describeError } from "../errors.js";
import { mapCoreError } from "./coreErrors.js";
import type { SessionGateway } from "./types.js";
import type { SessionStore } from "./sessionStore.js";

export type SessionStateStatus = "valid" | "expired" | "missing";

export interface SessionStatus {
  status: SessionStateStatus;
  expiresAt: number | undefined;
  updatedAt: number | undefined;
}

export interface SessionManagerOptions {
  gateway: SessionGateway;
  store: SessionStore;
  logger: AppLogger;
  now?: () => number;
}

/**
 * OTP login lifecycle. A verified session is sealed in the vault *before* the
 * live provider adopts it, so a persistence failure cannot leave a usable
 * session that disappears on restart.
 */
export class SessionManager {
  private readonly now: () => number;

  constructor(private readonly options: SessionManagerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  state(): SessionStateStatus {
    if (!this.options.gateway.hasSession()) return "missing";
    const expiresAt = this.options.gateway.sessionExpiresAt();
    if (expiresAt !== undefined && expiresAt <= this.now()) return "expired";
    return "valid";
  }

  status(): SessionStatus {
    return {
      status: this.state(),
      expiresAt: this.options.gateway.sessionExpiresAt(),
      updatedAt: this.options.store.updatedAt(),
    };
  }

  async requestOtp(phoneNumber: string): Promise<{ otpToken: string | null }> {
    try {
      const result = await this.options.gateway.requestOtp(phoneNumber);
      return { otpToken: result.otpToken ?? null };
    } catch (error) {
      const described = describeError(error);
      this.options.logger.warn("OTP request failed", {
        name: described.name,
        code: described.code,
      });
      throw mapCoreError(error);
    }
  }

  async verifyOtp(input: {
    otp: string;
    otpToken: string;
    phoneNumber?: string;
  }): Promise<SessionStatus> {
    let session: SessionState;
    try {
      session = await this.options.gateway.verifyOtp(input);
    } catch (error) {
      const described = describeError(error);
      this.options.logger.warn("OTP verification failed", {
        name: described.name,
        code: described.code,
      });
      throw mapCoreError(error);
    }

    this.options.store.save(session);
    await this.options.gateway.adoptSession(session);
    this.options.logger.info("GoPay session verified and persisted", {
      expiresAt:
        session.tokens.expiresAt !== undefined
          ? new Date(session.tokens.expiresAt).toISOString()
          : null,
    });
    return this.status();
  }

  /** Token refresh callback: persist before the provider keeps using it. */
  persistRefreshed(session: SessionState): void {
    this.options.store.save(session);
  }
}
