import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  verifyWebhookSignature,
  type WebhookDeliveryOptions,
  type WebhookDeliveryResult,
} from "merchantid/webhook";

import { createTestContext, type TestContext } from "./helpers/context.js";
import { TEST_WEBHOOK_SECRET } from "./helpers/config.js";
import { startWebhookReceiver } from "./helpers/webhookReceiver.js";

interface WireEvent {
  id: string;
  type: string;
  event: string;
  eventId: string;
  chargeId: string;
  orderId: string;
  providerTransactionId: string | null;
  amount: number;
  paidAt: string | null;
  data: Record<string, unknown>;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function deliveryResult(
  options: WebhookDeliveryOptions,
  ok: boolean,
  status = ok ? 200 : 500,
): WebhookDeliveryResult {
  return {
    ok,
    eventId: options.event.id,
    idempotencyKey: options.idempotencyKey ?? options.event.id,
    attempts: 1,
    ...(ok
      ? { status }
      : {
          status,
          error: {
            code: "HTTP_ERROR",
            message: "receiver failed",
            retryable: true,
          },
        }),
    durationMs: 0,
  };
}

async function setupCharge(ctx: TestContext, orderId: string) {
  const created = await ctx.request("/v1/charges", {
    method: "POST",
    body: JSON.stringify({ orderId, baseAmount: 145_000 }),
  });
  const charge = await ctx.json<{
    chargeId: string;
    uniqueAmount: number;
  }>(created);
  const transaction = ctx.fake?.queueTransaction(charge.uniqueAmount);
  return { charge, transaction };
}

describe("webhook delivery", () => {
  it("delivers a signed, contract-shaped payment.settled event", async () => {
    const receiver = await startWebhookReceiver();
    const ctx = await createTestContext({
      config: {
        webhook: {
          url: receiver.url,
          maxAttempts: 3,
          baseDelayMs: 10,
          maxDelayMs: 50,
        },
      },
    });
    try {
      const { charge, transaction } = await setupCharge(ctx, "KN-W1");
      const reconcile = await ctx.request("/v1/reconcile", { method: "POST" });
      const summary = await ctx.json<{ webhooksDelivered: number }>(reconcile);
      expect(summary.webhooksDelivered).toBe(1);

      const received = await receiver.waitFor(1);
      const body = received.body;
      const event = JSON.parse(body) as WireEvent;

      expect(event.event).toBe("payment.settled");
      expect(event.type).toBe("payment.settled");
      expect(event.eventId).toBe(`${charge.chargeId}:payment.settled`);
      expect(event.chargeId).toBe(charge.chargeId);
      expect(event.orderId).toBe("KN-W1");
      expect(event.providerTransactionId).toBe(transaction?.id);
      expect(event.amount).toBe(charge.uniqueAmount);
      expect(Number.isNaN(Date.parse(event.paidAt ?? ""))).toBe(false);
      expect(event.data.paymentId).toBeDefined();

      expect(header(received.headers, "x-merchantid-idempotency-key")).toBe(
        event.eventId,
      );
      expect(header(received.headers, "x-kalanidhi-event-id")).toBe(
        event.eventId,
      );

      const merchantSignature = header(
        received.headers,
        "x-merchantid-signature",
      );
      expect(
        verifyWebhookSignature({
          body,
          signatureHeader: merchantSignature,
          secret: TEST_WEBHOOK_SECRET,
          toleranceSeconds: 300,
        }),
      ).toBe(true);

      const timestamp = header(received.headers, "x-kalanidhi-timestamp");
      const expected = createHmac("sha256", TEST_WEBHOOK_SECRET)
        .update(`${timestamp}.${body}`, "utf8")
        .digest("hex");
      expect(header(received.headers, "x-kalanidhi-signature")).toBe(
        `sha256=${expected}`,
      );

      expect(
        verifyWebhookSignature({
          body: `${body} `,
          signatureHeader: merchantSignature,
          secret: TEST_WEBHOOK_SECRET,
          toleranceSeconds: 300,
        }),
      ).toBe(false);

      expect(body).not.toContain("FAKE-QRIS");
      expect(body).not.toContain("fake-access-token");
      expect(body).not.toContain("otp");

      const outbox = ctx.gateway.repo.getWebhook(event.eventId);
      expect(outbox?.status).toBe("delivered");
      expect(outbox?.attempts).toBe(1);
    } finally {
      await ctx.close();
      await receiver.close();
    }
  });

  it("delivers payment.expired with a null paidAt", async () => {
    const receiver = await startWebhookReceiver();
    const ctx = await createTestContext({
      config: { webhook: { url: receiver.url, maxAttempts: 2 } },
    });
    try {
      const created = await ctx.request("/v1/charges", {
        method: "POST",
        body: JSON.stringify({
          orderId: "KN-W2",
          baseAmount: 10_000,
          expiresInSeconds: 30,
        }),
      });
      const charge = await ctx.json<{ chargeId: string }>(created);
      ctx.advance(31_000);
      await ctx.request("/v1/reconcile", { method: "POST" });

      const received = await receiver.waitFor(1);
      const event = JSON.parse(received.body) as WireEvent;
      expect(event.event).toBe("payment.expired");
      expect(event.eventId).toBe(`${charge.chargeId}:payment.expired`);
      expect(event.paidAt).toBeNull();
      expect(event.providerTransactionId).toBeNull();
    } finally {
      await ctx.close();
      await receiver.close();
    }
  });

  it("retries with a stable id and idempotency key, then delivers", async () => {
    const calls: WebhookDeliveryOptions[] = [];
    let failures = 2;
    const ctx = await createTestContext({
      config: {
        webhook: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 100 },
      },
      webhookDeliver: async (options) => {
        calls.push(options);
        if (failures > 0) {
          failures -= 1;
          return deliveryResult(options, false);
        }
        return deliveryResult(options, true);
      },
    });
    try {
      const { charge } = await setupCharge(ctx, "KN-W3");
      const first = await ctx.json<{ webhooksRetrying: number }>(
        await ctx.request("/v1/reconcile", { method: "POST" }),
      );
      expect(first.webhooksRetrying).toBe(1);

      let row = ctx.gateway.repo.getWebhook(
        `${charge.chargeId}:payment.settled`,
      );
      expect(row?.attempts).toBe(1);
      expect(row?.nextAttemptAt).toBeGreaterThan(ctx.clock.value - 1);

      ctx.advance(1_000);
      const second = await ctx.json<{ webhooksRetrying: number }>(
        await ctx.request("/v1/reconcile", { method: "POST" }),
      );
      expect(second.webhooksRetrying).toBe(1);

      ctx.advance(1_000);
      const third = await ctx.json<{ webhooksDelivered: number }>(
        await ctx.request("/v1/reconcile", { method: "POST" }),
      );
      expect(third.webhooksDelivered).toBe(1);

      expect(calls).toHaveLength(3);
      const ids = new Set(calls.map((call) => call.event.id));
      const keys = new Set(calls.map((call) => call.idempotencyKey));
      const bodies = new Set(calls.map((call) => JSON.stringify(call.event)));
      expect(ids.size).toBe(1);
      expect(keys.size).toBe(1);
      expect(bodies.size).toBe(1);

      row = ctx.gateway.repo.getWebhook(`${charge.chargeId}:payment.settled`);
      expect(row?.status).toBe("delivered");
      expect(row?.attempts).toBe(3);
    } finally {
      await ctx.close();
    }
  });

  it("dead-letters after the configured attempt limit", async () => {
    const ctx = await createTestContext({
      config: {
        webhook: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 100 },
      },
      webhookDeliver: async (options) => deliveryResult(options, false),
    });
    try {
      const { charge } = await setupCharge(ctx, "KN-W4");
      await ctx.request("/v1/reconcile", { method: "POST" });
      ctx.advance(1_000);
      const second = await ctx.json<{ webhooksDeadLettered: number }>(
        await ctx.request("/v1/reconcile", { method: "POST" }),
      );
      expect(second.webhooksDeadLettered).toBe(1);

      const row = ctx.gateway.repo.getWebhook(
        `${charge.chargeId}:payment.settled`,
      );
      expect(row?.status).toBe("dead");
      expect(row?.attempts).toBe(2);
    } finally {
      await ctx.close();
    }
  });

  it("dead-letters an unsafe webhook URL instead of retrying forever", async () => {
    const ctx = await createTestContext({
      config: {
        webhook: {
          url: "http://127.0.0.1:9/hook",
          allowHttp: false,
          allowPrivateNetworks: false,
        },
      },
    });
    try {
      const { charge } = await setupCharge(ctx, "KN-W5");
      const summary = await ctx.json<{ webhooksDeadLettered: number }>(
        await ctx.request("/v1/reconcile", { method: "POST" }),
      );
      expect(summary.webhooksDeadLettered).toBe(1);

      const row = ctx.gateway.repo.getWebhook(
        `${charge.chargeId}:payment.settled`,
      );
      expect(row?.status).toBe("dead");
      expect(row?.lastError).toContain("WEBHOOK_SECURITY");
    } finally {
      await ctx.close();
    }
  });

  it("emits payment.failed only for application-level failures", async () => {
    const calls: WebhookDeliveryOptions[] = [];
    const ctx = await createTestContext({
      webhookDeliver: async (options) => {
        calls.push(options);
        return deliveryResult(options, true);
      },
    });
    try {
      const created = await ctx.request("/v1/charges", {
        method: "POST",
        body: JSON.stringify({ orderId: "KN-W6", baseAmount: 20_000 }),
      });
      const charge = await ctx.json<{ chargeId: string }>(created);
      await ctx.gateway.charges.markFailed(charge.chargeId, "ORDER_REJECTED");
      const summary = await ctx.gateway.charges.deliverWebhooks();
      expect(summary.delivered).toBe(1);

      const call = calls[0];
      if (!call) throw new Error("no delivery call");
      const event = call.event as unknown as WireEvent;
      expect(event.event).toBe("payment.failed");
      expect(event.eventId).toBe(`${charge.chargeId}:payment.failed`);
      expect(event.paidAt).toBeNull();
      expect(event.data.status).toBe("failed");
      expect(event.data.reasonCode).toBe("ORDER_REJECTED");
      expect(JSON.stringify(event)).not.toContain("FAKE-QRIS");
    } finally {
      await ctx.close();
    }
  });

  it("drains the outbox while the provider session is unavailable", async () => {
    const calls: WebhookDeliveryOptions[] = [];
    const ctx = await createTestContext({
      webhookDeliver: async (options) => {
        calls.push(options);
        return deliveryResult(options, true);
      },
    });
    try {
      const created = await ctx.request("/v1/charges", {
        method: "POST",
        body: JSON.stringify({ orderId: "KN-W7", baseAmount: 30_000 }),
      });
      const charge = await ctx.json<{ chargeId: string }>(created);
      await ctx.gateway.charges.markFailed(charge.chargeId, "ORDER_REJECTED");
      ctx.fake?.setSessionMissing();

      const reconcile = await ctx.request("/v1/reconcile", { method: "POST" });
      expect(reconcile.status).toBe(503);
      expect(calls).toHaveLength(1);
      expect(
        ctx.gateway.repo.getWebhook(`${charge.chargeId}:payment.failed`)
          ?.status,
      ).toBe("delivered");
    } finally {
      await ctx.close();
    }
  });
});
