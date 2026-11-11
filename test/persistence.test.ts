import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type {
  WebhookDeliveryOptions,
  WebhookDeliveryResult,
} from "merchantid/webhook";

import { createTestContext } from "./helpers/context.js";
import { RealCoreHarness } from "./helpers/realCore.js";

const deliverOk = async (
  options: WebhookDeliveryOptions,
): Promise<WebhookDeliveryResult> => ({
  ok: true,
  eventId: options.event.id,
  idempotencyKey: options.idempotencyKey ?? options.event.id,
  attempts: 1,
  status: 200,
  durationMs: 0,
});

interface ChargeResponse {
  chargeId: string;
  uniqueAmount: number;
  status: string;
  providerTransactionId: string | null;
}

describe("restart persistence", () => {
  it("survives a process restart: charge state, claims, and last reconcile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kalanidhi-restart-"));
    const storePath = join(dir, "payments.sqlite");
    try {
      const harness1 = new RealCoreHarness({
        path: storePath,
        merchantId: "G000000001",
        clockSkewMs: 0,
        defaultExpiryMs: 600_000,
      });
      const first = await createTestContext({
        dir,
        storePath,
        core: harness1,
        webhookDeliver: deliverOk,
      });

      let paidCharge: ChargeResponse;
      let pendingCharge: ChargeResponse;
      let transactionId: string;
      let lastReconcileAt: string | undefined;
      try {
        const paid = await first.request("/v1/charges", {
          method: "POST",
          body: JSON.stringify({ orderId: "KN-P1", baseAmount: 145_000 }),
        });
        paidCharge = await first.json<ChargeResponse>(paid);
        const transaction = harness1.queueTransaction(paidCharge.uniqueAmount);
        transactionId = transaction.id;

        const pending = await first.request("/v1/charges", {
          method: "POST",
          body: JSON.stringify({ orderId: "KN-P2", baseAmount: 90_000 }),
        });
        pendingCharge = await first.json<ChargeResponse>(pending);

        const reconcile = await first.request("/v1/reconcile", {
          method: "POST",
        });
        expect(reconcile.status).toBe(200);
        lastReconcileAt = first.gateway.runner.last()?.completedAt;
        expect(lastReconcileAt).toBeTruthy();
      } finally {
        await first.close();
      }

      const harness2 = new RealCoreHarness({
        path: storePath,
        merchantId: "G000000001",
        clockSkewMs: 0,
        defaultExpiryMs: 600_000,
      });
      const second = await createTestContext({
        dir,
        storePath,
        core: harness2,
        webhookDeliver: deliverOk,
      });
      try {
        const paidAfter = await second.json<ChargeResponse>(
          await second.request(`/v1/charges/${paidCharge.chargeId}`),
        );
        expect(paidAfter.status).toBe("paid");
        expect(paidAfter.providerTransactionId).toBe(transactionId);

        const pendingAfter = await second.json<ChargeResponse>(
          await second.request(`/v1/charges/${pendingCharge.chargeId}`),
        );
        expect(pendingAfter.status).toBe("pending");
        expect(pendingAfter.uniqueAmount).toBe(pendingCharge.uniqueAmount);

        const health = await second.json<{
          pendingCharges: number;
          lastReconcileAt: string | null;
        }>(await second.request("/v1/health"));
        expect(health.pendingCharges).toBe(1);
        expect(health.lastReconcileAt).toBe(lastReconcileAt);

        // Reuse the old amount for a fresh charge. The provider transaction id
        // is already claimed durably, so even a replayed feed row cannot settle
        // the new charge.
        const reused = await second.request("/v1/charges", {
          method: "POST",
          body: JSON.stringify({ orderId: "KN-P3", baseAmount: 145_000 }),
        });
        const reusedCharge = await second.json<ChargeResponse>(reused);
        expect(reusedCharge.uniqueAmount).toBe(paidCharge.uniqueAmount);

        harness2.feed.queue({
          id: transactionId,
          orderId: "QRIS-REPLAY",
          merchantId: "G000000001",
          status: "SETTLEMENT",
          paymentType: "QRIS",
          grossAmount: reusedCharge.uniqueAmount,
          currency: "IDR",
          transactionTime: new Date().toISOString(),
          raw: {},
        });

        const summary = await second.json<{ paid: number }>(
          await second.request("/v1/reconcile", { method: "POST" }),
        );
        expect(summary.paid).toBe(0);
        const stillPending = await second.json<ChargeResponse>(
          await second.request(`/v1/charges/${reusedCharge.chargeId}`),
        );
        expect(stillPending.status).toBe("pending");
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the freed-amount quarantine across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kalanidhi-restart-"));
    const storePath = join(dir, "payments.sqlite");
    try {
      const harness1 = new RealCoreHarness({
        path: storePath,
        merchantId: "G000000001",
        clockSkewMs: 60_000,
        defaultExpiryMs: 600_000,
      });
      const first = await createTestContext({
        dir,
        storePath,
        core: harness1,
        webhookDeliver: deliverOk,
        config: { reconcile: { clockSkewMs: 60_000 } },
      });
      let cancelled: ChargeResponse;
      try {
        const created = await first.json<ChargeResponse>(
          await first.request("/v1/charges", {
            method: "POST",
            body: JSON.stringify({ orderId: "KN-Q1", baseAmount: 10_000 }),
          }),
        );
        cancelled = created;
        expect(cancelled.uniqueAmount).toBe(10_001);
        await first.request(`/v1/charges/${cancelled.chargeId}/cancel`, {
          method: "POST",
        });
      } finally {
        await first.close();
      }

      const harness2 = new RealCoreHarness({
        path: storePath,
        merchantId: "G000000001",
        clockSkewMs: 60_000,
        defaultExpiryMs: 600_000,
      });
      const second = await createTestContext({
        dir,
        storePath,
        core: harness2,
        webhookDeliver: deliverOk,
        config: { reconcile: { clockSkewMs: 60_000 } },
      });
      try {
        const next = await second.json<ChargeResponse>(
          await second.request("/v1/charges", {
            method: "POST",
            body: JSON.stringify({ orderId: "KN-Q2", baseAmount: 10_000 }),
          }),
        );
        expect(next.uniqueAmount).toBe(10_002);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the SQLite WAL files inside the configured directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kalanidhi-restart-"));
    const storePath = join(dir, "payments.sqlite");
    try {
      const harness = new RealCoreHarness({
        path: storePath,
        merchantId: "G000000001",
        clockSkewMs: 0,
        defaultExpiryMs: 600_000,
      });
      const ctx = await createTestContext({
        dir,
        storePath,
        core: harness,
        webhookDeliver: deliverOk,
      });
      try {
        await ctx.request("/v1/charges", {
          method: "POST",
          body: JSON.stringify({ orderId: "KN-P4", baseAmount: 5_000 }),
        });
      } finally {
        await ctx.close();
      }
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(dir);
      expect(files).toContain("payments.sqlite");
      expect(files.every((file) => file.startsWith("payments.sqlite"))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
