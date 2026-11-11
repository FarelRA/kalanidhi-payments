import { afterEach, describe, expect, it } from "vitest";

import { createTestContext, type TestContext } from "./helpers/context.js";

interface ChargeResponse {
  chargeId: string;
  orderId: string;
  baseAmount: number;
  uniqueAmount: number;
  description: string | null;
  status: string;
  qrString: string | null;
  providerReference: string | null;
  providerTransactionId: string | null;
  paidAt: string | null;
  expiresAt: string;
  createdAt: string;
  failureCode: string | null;
}

interface ReconcileSummary {
  ran: boolean;
  paid: number;
  expired: number;
  webhooksDelivered: number;
  webhooksRetrying: number;
  webhooksDeadLettered: number;
  durationMs: number;
  completedAt: string;
}

describe("charge lifecycle", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.close();
  });

  const create = (
    orderId: string,
    options: { baseAmount?: number; expiresInSeconds?: number } = {},
  ) =>
    ctx.request("/v1/charges", {
      method: "POST",
      body: JSON.stringify({
        orderId,
        baseAmount: options.baseAmount ?? 1_450_000,
        ...(options.expiresInSeconds !== undefined
          ? { expiresInSeconds: options.expiresInSeconds }
          : {}),
        description: "Batik Tulis Soga",
      }),
    });

  it("creates a pending charge with a unique amount and QRIS", async () => {
    ctx = await createTestContext({ logLevel: "debug" });
    const response = await create("KN-2026-1000");
    expect(response.status).toBe(201);
    const charge = await ctx.json<ChargeResponse>(response);

    const requestId = response.headers.get("x-request-id");
    const domainLog = ctx.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.msg === "charge created");
    expect(domainLog?.requestId).toBe(requestId);

    expect(charge.chargeId).toMatch(/^ch_[a-f0-9]{32}$/);
    expect(charge.orderId).toBe("KN-2026-1000");
    expect(charge.baseAmount).toBe(1_450_000);
    expect(charge.uniqueAmount).toBeGreaterThan(1_450_000);
    expect(charge.uniqueAmount).toBeLessThanOrEqual(1_450_999);
    expect(charge.status).toBe("pending");
    expect(charge.qrString).toMatch(/^FAKE-QRIS-/);
    expect(charge.description).toBe("Batik Tulis Soga");
    expect(Number.isNaN(Date.parse(charge.expiresAt))).toBe(false);
    expect(Number.isNaN(Date.parse(charge.createdAt))).toBe(false);
  });

  it("returns stored status only and does not read the provider on GET", async () => {
    ctx = await createTestContext();
    const charge = await ctx.json<ChargeResponse>(await create("KN-2026-1001"));
    const before = ctx.fake?.getPaymentCalls ?? 0;

    // Change core state without a lifecycle event. GET must still show pending.
    const corePayment = [...(ctx.fake?.payments.values() ?? [])][0];
    if (!corePayment) throw new Error("missing fake payment");
    ctx.fake?.forceStatus(corePayment.id, "paid");

    const response = await ctx.request(`/v1/charges/${charge.chargeId}`);
    const status = await ctx.json<ChargeResponse>(response);
    expect(status.status).toBe("pending");
    expect(ctx.fake?.getPaymentCalls).toBe(before);
  });

  it("cancels a pending charge and refuses a second cancel", async () => {
    ctx = await createTestContext();
    const charge = await ctx.json<ChargeResponse>(await create("KN-2026-1002"));

    const cancelled = await ctx.request(
      `/v1/charges/${charge.chargeId}/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(200);
    expect((await ctx.json<ChargeResponse>(cancelled)).status).toBe(
      "cancelled",
    );

    const again = await ctx.request(`/v1/charges/${charge.chargeId}/cancel`, {
      method: "POST",
    });
    expect(again.status).toBe(409);
    const body = await ctx.json<{
      error: { code: string; details: { status: string } };
    }>(again);
    expect(body.error.code).toBe("CHARGE_NOT_PENDING");
    expect(body.error.details.status).toBe("cancelled");
  });

  it("cancels an unknown charge with 404", async () => {
    ctx = await createTestContext();
    const response = await ctx.request("/v1/charges/ch_unknown/cancel", {
      method: "POST",
    });
    expect(response.status).toBe(404);
    expect(
      (await ctx.json<{ error: { code: string } }>(response)).error.code,
    ).toBe("CHARGE_NOT_FOUND");
  });

  it("settles a charge on reconcile and records the transaction", async () => {
    ctx = await createTestContext();
    const charge = await ctx.json<ChargeResponse>(await create("KN-2026-1003"));
    const transaction = ctx.fake?.queueTransaction(charge.uniqueAmount);
    if (!transaction) throw new Error("missing transaction");

    const response = await ctx.request("/v1/reconcile", { method: "POST" });
    expect(response.status).toBe(200);
    const summary = await ctx.json<ReconcileSummary>(response);
    expect(summary.ran).toBe(true);
    expect(summary.paid).toBe(1);
    expect(summary.expired).toBe(0);

    const status = await ctx.json<ChargeResponse>(
      await ctx.request(`/v1/charges/${charge.chargeId}`),
    );
    expect(status.status).toBe("paid");
    expect(status.providerTransactionId).toBe(transaction.id);
    expect(status.providerReference).toBe(transaction.id);
    expect(status.paidAt).not.toBeNull();
    expect(
      (
        ctx.gateway.repo.getWebhook(`${charge.chargeId}:payment.settled`) ??
        undefined
      )?.status,
    ).toBe("pending");
  });

  it("refuses to cancel a charge that already settled", async () => {
    ctx = await createTestContext();
    const charge = await ctx.json<ChargeResponse>(await create("KN-2026-1004"));
    ctx.fake?.queueTransaction(charge.uniqueAmount);
    await ctx.request("/v1/reconcile", { method: "POST" });

    const response = await ctx.request(
      `/v1/charges/${charge.chargeId}/cancel`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
    const body = await ctx.json<{
      error: { code: string; details: { status: string } };
    }>(response);
    expect(body.error.code).toBe("CHARGE_NOT_PENDING");
    expect(body.error.details.status).toBe("paid");
  });

  it("expires a stale charge on reconcile", async () => {
    ctx = await createTestContext();
    const charge = await ctx.json<ChargeResponse>(
      await create("KN-2026-1005", { expiresInSeconds: 30 }),
    );
    ctx.advance(31_000);

    const response = await ctx.request("/v1/reconcile", { method: "POST" });
    const summary = await ctx.json<ReconcileSummary>(response);
    expect(summary.expired).toBe(1);

    const status = await ctx.json<ChargeResponse>(
      await ctx.request(`/v1/charges/${charge.chargeId}`),
    );
    expect(status.status).toBe("expired");
    expect(status.paidAt).toBeNull();
    expect(
      ctx.gateway.repo.getWebhook(`${charge.chargeId}:payment.expired`)?.status,
    ).toBe("pending");
  });

  it("does not emit a webhook for a buyer cancellation", async () => {
    ctx = await createTestContext();
    const charge = await ctx.json<ChargeResponse>(await create("KN-2026-1006"));
    await ctx.request(`/v1/charges/${charge.chargeId}/cancel`, {
      method: "POST",
    });
    expect(
      ctx.gateway.repo.getWebhook(`${charge.chargeId}:payment.failed`),
    ).toBeUndefined();
    expect(
      ctx.gateway.repo.getWebhook(`${charge.chargeId}:payment.expired`),
    ).toBeUndefined();
  });

  it("supports an application-level failure with a failed webhook", async () => {
    ctx = await createTestContext();
    const charge = await ctx.json<ChargeResponse>(await create("KN-2026-1007"));

    const failed = await ctx.gateway.charges.markFailed(
      charge.chargeId,
      "ORDER_REJECTED",
    );
    expect(failed.status).toBe("failed");
    expect(failed.failureCode).toBe("ORDER_REJECTED");
    const corePayment = [...(ctx.fake?.payments.values() ?? [])][0];
    expect(corePayment?.status).toBe("cancelled");

    const outbox = ctx.gateway.repo.getWebhook(
      `${charge.chargeId}:payment.failed`,
    );
    expect(outbox?.status).toBe("pending");
    expect(outbox?.payload).toContain("ORDER_REJECTED");
    expect(outbox?.payload).not.toContain("FAKE-QRIS");
  });

  it("pauses charge creation and reconciliation without a session", async () => {
    ctx = await createTestContext();
    ctx.fake?.setSessionMissing();

    const response = await create("KN-2026-1008");
    expect(response.status).toBe(503);
    expect(
      (await ctx.json<{ error: { code: string } }>(response)).error.code,
    ).toBe("SESSION_UNAVAILABLE");

    const reconcile = await ctx.request("/v1/reconcile", { method: "POST" });
    expect(reconcile.status).toBe(503);
  });

  it("pauses cancellation without a session", async () => {
    ctx = await createTestContext();
    const charge = await ctx.json<ChargeResponse>(await create("KN-2026-1009"));
    ctx.fake?.setSessionMissing();
    const response = await ctx.request(
      `/v1/charges/${charge.chargeId}/cancel`,
      { method: "POST" },
    );
    expect(response.status).toBe(503);
  });
});
