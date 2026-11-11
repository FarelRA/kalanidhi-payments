import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestContext } from "./helpers/context.js";

interface SessionStatus {
  status: string;
  expiresAt: string | null;
  updatedAt: string | null;
}

describe("session and OTP", () => {
  it("starts missing, requests an OTP, and persists a verified session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kalanidhi-session-"));
    const ctx = await createTestContext({
      dir,
      fakeOptions: { sessionPresent: false },
    });
    try {
      let status = await ctx.json<SessionStatus>(
        await ctx.request("/v1/session/status"),
      );
      expect(status.status).toBe("missing");
      expect(status.expiresAt).toBeNull();
      expect(status.updatedAt).toBeNull();

      const otpResponse = await ctx.request("/v1/session/request-otp", {
        method: "POST",
        body: JSON.stringify({ phoneNumber: "+62 812-3456-7890" }),
      });
      expect(otpResponse.status).toBe(200);
      const otpBody = await ctx.json<{ otpToken: string | null }>(otpResponse);
      expect(otpBody.otpToken).toBeTruthy();
      expect(ctx.fake?.lastPhone).toBe("+62 812-3456-7890");
      expect(JSON.stringify(otpBody)).not.toContain("access");

      const verifyResponse = await ctx.request("/v1/session/verify-otp", {
        method: "POST",
        body: JSON.stringify({ otp: "123456", otpToken: otpBody.otpToken }),
      });
      expect(verifyResponse.status).toBe(200);
      const verified = await ctx.json<{ status: string; expiresAt: string }>(
        verifyResponse,
      );
      expect(verified.status).toBe("valid");
      expect(Number.isNaN(Date.parse(verified.expiresAt))).toBe(false);

      status = await ctx.json<SessionStatus>(
        await ctx.request("/v1/session/status"),
      );
      expect(status.status).toBe("valid");
      expect(status.updatedAt).not.toBeNull();

      // The vault stores ciphertext only.
      const row = ctx.gateway.db.raw
        .prepare("SELECT envelope FROM gateway_session WHERE id = 'gopay'")
        .get() as { envelope: string };
      expect(row.envelope).toMatch(/^mv1\./);
      expect(row.envelope).not.toContain("fake-access-token");
      expect(row.envelope).not.toContain("fake-refresh-token");
    } finally {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores a persisted session after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kalanidhi-session-"));
    const first = await createTestContext({
      dir,
      fakeOptions: { sessionPresent: false },
    });
    try {
      const otp = await first.json<{ otpToken: string | null }>(
        await first.request("/v1/session/request-otp", {
          method: "POST",
          body: JSON.stringify({ phoneNumber: "08123456789" }),
        }),
      );
      const verify = await first.request("/v1/session/verify-otp", {
        method: "POST",
        body: JSON.stringify({ otp: "123456", otpToken: otp.otpToken }),
      });
      expect(verify.status).toBe(200);
      await first.close();

      const second = await createTestContext({
        dir,
        fakeOptions: { sessionPresent: false },
      });
      try {
        const status = await second.json<SessionStatus>(
          await second.request("/v1/session/status"),
        );
        expect(status.status).toBe("valid");
        expect(status.updatedAt).not.toBeNull();
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the vault passphrase changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kalanidhi-session-"));
    const first = await createTestContext({
      dir,
      fakeOptions: { sessionPresent: false },
    });
    try {
      const otp = await first.json<{ otpToken: string | null }>(
        await first.request("/v1/session/request-otp", {
          method: "POST",
          body: JSON.stringify({ phoneNumber: "08123456789" }),
        }),
      );
      await first.request("/v1/session/verify-otp", {
        method: "POST",
        body: JSON.stringify({ otp: "123456", otpToken: otp.otpToken }),
      });
      await first.close();

      const second = await createTestContext({
        dir,
        fakeOptions: { sessionPresent: false },
        config: { vaultPassphrase: "a-different-passphrase-123" },
      });
      try {
        const status = await second.json<SessionStatus>(
          await second.request("/v1/session/status"),
        );
        expect(status.status).toBe("missing");
        expect(second.logs.join("\n")).toContain(
          "session vault could not be opened",
        );
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a stable 401 when the OTP is wrong", async () => {
    const ctx = await createTestContext({
      fakeOptions: { sessionPresent: false },
    });
    try {
      const response = await ctx.request("/v1/session/verify-otp", {
        method: "POST",
        body: JSON.stringify({ otp: "000000", otpToken: "token" }),
      });
      expect(response.status).toBe(401);
      const body = await ctx.json<{ error: { code: string } }>(response);
      expect(body.error.code).toBe("SESSION_AUTH_FAILED");
      expect(
        (await ctx.json<SessionStatus>(await ctx.request("/v1/session/status")))
          .status,
      ).toBe("missing");
    } finally {
      await ctx.close();
    }
  });

  it("reports an expired session without exposing tokens", async () => {
    const ctx = await createTestContext();
    try {
      ctx.fake?.adoptSession({
        tokens: {
          accessToken: "expired-access-token",
          refreshToken: "expired-refresh-token",
          tokenType: "Bearer",
          expiresAt: ctx.clock.value - 1,
        },
        deviceId: "device",
      });
      const response = await ctx.request("/v1/session/status");
      const text = await response.text();
      const status = JSON.parse(text) as SessionStatus;
      expect(status.status).toBe("expired");
      expect(text).not.toContain("expired-access-token");
      expect(text).not.toContain("expired-refresh-token");
    } finally {
      await ctx.close();
    }
  });
});
