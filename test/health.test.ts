import { afterEach, describe, expect, it } from "vitest";

import { createTestContext, type TestContext } from "./helpers/context.js";
import {
  TEST_INTERNAL_KEY,
  TEST_VAULT_PASSPHRASE,
  TEST_WEBHOOK_SECRET,
} from "./helpers/config.js";

interface Health {
  status: string;
  version: string;
  uptimeSeconds: number;
  session: string;
  pendingCharges: number;
  lastReconcileAt: string | null;
  lastReconcileDurationMs: number | null;
  lastReconcileFailedAt: string | null;
  reconcilerRunning: boolean;
}

describe("health endpoint", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.close();
  });

  it("reports status, uptime, session and pending counts", async () => {
    ctx = await createTestContext();
    ctx.advance(5_000);

    const response = await ctx.request("/v1/health");
    expect(response.status).toBe(200);
    const health = await ctx.json<Health>(response);
    expect(health.status).toBe("ok");
    expect(health.version).toBe("0.1.0");
    expect(health.uptimeSeconds).toBe(5);
    expect(health.session).toBe("valid");
    expect(health.pendingCharges).toBe(0);
    expect(health.lastReconcileAt).toBeNull();
    expect(health.lastReconcileDurationMs).toBeNull();
    expect(health.reconcilerRunning).toBe(false);

    const created = await ctx.request("/v1/charges", {
      method: "POST",
      body: JSON.stringify({ orderId: "KN-H1", baseAmount: 10_000 }),
    });
    const charge = await ctx.json<{ chargeId: string }>(created);
    expect(
      (await ctx.json<Health>(await ctx.request("/v1/health"))).pendingCharges,
    ).toBe(1);

    await ctx.request(`/v1/charges/${charge.chargeId}/cancel`, {
      method: "POST",
    });
    expect(
      (await ctx.json<Health>(await ctx.request("/v1/health"))).pendingCharges,
    ).toBe(0);
  });

  it("reports missing and expired sessions without warning about secrets", async () => {
    ctx = await createTestContext();
    ctx.fake?.setSessionMissing();
    let health = await ctx.json<Health>(await ctx.request("/v1/health"));
    expect(health.session).toBe("missing");
    expect(health.status).toBe("degraded");

    ctx.fake?.adoptSession({
      tokens: {
        accessToken: "expired-access-token",
        refreshToken: "expired-refresh-token",
        tokenType: "Bearer",
        expiresAt: ctx.clock.value - 1_000,
      },
      deviceId: "device",
    });
    health = await ctx.json<Health>(await ctx.request("/v1/health"));
    expect(health.session).toBe("expired");
    expect(health.status).toBe("degraded");
  });

  it("updates last reconcile time after a tick", async () => {
    ctx = await createTestContext();
    const response = await ctx.request("/v1/reconcile", { method: "POST" });
    expect(response.status).toBe(200);

    const health = await ctx.json<Health>(await ctx.request("/v1/health"));
    expect(health.lastReconcileAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(health.lastReconcileAt ?? ""))).toBe(false);
    expect(health.lastReconcileDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("never returns keys, secrets, tokens, OTPs, or QRIS payloads", async () => {
    ctx = await createTestContext({ logLevel: "debug" });
    await ctx.request("/v1/charges", {
      method: "POST",
      body: JSON.stringify({ orderId: "KN-H2", baseAmount: 20_000 }),
    });
    await ctx.request("/v1/session/request-otp", {
      method: "POST",
      body: JSON.stringify({ phoneNumber: "08123456789" }),
    });

    const response = await ctx.request("/v1/health");
    const text = await response.text();
    expect(text).not.toContain(TEST_INTERNAL_KEY);
    expect(text).not.toContain(TEST_WEBHOOK_SECRET);
    expect(text).not.toContain(TEST_VAULT_PASSPHRASE);
    expect(text).not.toContain("FAKE-QRIS");
    expect(text).not.toContain("fake-access-token");
    expect(text).not.toContain("otp-token");
    expect(text).not.toContain("qrString");

    const logs = ctx.logs.join("\n");
    expect(logs).not.toContain(TEST_INTERNAL_KEY);
    expect(logs).not.toContain(TEST_WEBHOOK_SECRET);
    expect(logs).not.toContain(TEST_VAULT_PASSPHRASE);
    expect(logs).not.toContain("FAKE-QRIS");
    expect(logs).not.toContain("fake-access-token");
    expect(logs).not.toContain("otp-token");
  });
});
