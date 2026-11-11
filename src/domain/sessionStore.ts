import type { SessionState } from "merchantid";
import type { SessionVault, VaultError } from "merchantid/vault";

import type { AppLogger } from "../logger.js";
import { describeError } from "../errors.js";
import type { ChargeRepository } from "./repository.js";

const CONTEXT = "kalanidhi-payments/gopay-session/v1";

/**
 * Encrypts sessions before they touch SQLite. The vault key must live outside
 * the database volume; the repository stores only the envelope.
 */
export class SessionStore {
  constructor(
    private readonly vault: SessionVault,
    private readonly repo: ChargeRepository,
    private readonly logger: AppLogger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  load(): SessionState | undefined {
    const row = this.repo.loadSession();
    if (!row) return undefined;
    try {
      return this.vault.open(row.envelope, CONTEXT);
    } catch (error) {
      const code = (error as Partial<VaultError>).code;
      const described = describeError(error);
      this.logger.error("session vault could not be opened", {
        name: described.name,
        code: code ?? described.code ?? "DECRYPT_FAILED",
      });
      return undefined;
    }
  }

  save(session: SessionState): void {
    const envelope = this.vault.seal(session, CONTEXT);
    this.repo.saveSession(envelope, this.now());
  }

  updatedAt(): number | undefined {
    return this.repo.loadSession()?.updatedAt;
  }
}
