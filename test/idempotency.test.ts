import { afterEach, describe, expect, it } from "vitest";

import { createTestContext, type TestContext } from "./helpers/context.js";

interface ChargeResponse {
  chargeId: string;
  orderId: string;
  baseAmount: number;
  uniqueAmount: number;
  status: string;
  qrString: string | null;
}

describe("charge idempotency", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.close();
  });

  const create = (orderId: string, baseAmount = 100_000) =>
    ctx.request("/v1/charges", {
      method: "POST",
      body: JSON.stringify({ orderId, baseAmount }),
    });

  it("creates once and returns the stored charge on replay", async () => {
    ctx = await createTestContext();
    const first = await create("KN-2026-0001");
    expect(first.status).toBe(201);
    const firstBody = await ctx.json<ChargeResponse>(first);

    const second = await create("KN-2026-0001");
    expect(second.status).toBe(200);
    const secondBody = await ctx.json<ChargeResponse>(second);

    expect(secondBody.chargeId).toBe(firstBody.chargeId);
    expect(secondBody.uniqueAmount).toBe(firstBody.uniqueAmount);
    expect(secondBody.qrString).toBe(firstBody.qrString);
    expect(ctx.fake?.createCount).toBe(1);
  });

  it("rejects the same order with a different base amount", async () => {
    ctx = await createTestContext();
    await create("KN-2026-0002", 100_000);
    const response = await create("KN-2026-0002", 200_000);
    expect(response.status).toBe(409);
    const body = await ctx.json<{ error: { code: string } }>(response);
    expect(body.error.code).toBe("ORDER_AMOUNT_MISMATCH");
    expect(ctx.fake?.createCount).toBe(1);
  });

  it("serializes concurrent creates for the same order", async () => {
    ctx = await createTestContext();
    const responses = await Promise.all([
      create("KN-2026-0003"),
      create("KN-2026-0003"),
      create("KN-2026-0003"),
    ]);
    const bodies = await Promise.all(
      responses.map((response) => ctx.json<ChargeResponse>(response)),
    );
    const ids = new Set(bodies.map((body) => body.chargeId));
    expect(ids.size).toBe(1);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 200, 201,
    ]);
    expect(ctx.fake?.createCount).toBe(1);
  });

  it("allocates different unique amounts for same-priced orders", async () => {
    ctx = await createTestContext();
    const responses = await Promise.all([
      create("KN-A", 145_000),
      create("KN-B", 145_000),
      create("KN-C", 145_000),
    ]);
    const bodies = await Promise.all(
      responses.map((response) => ctx.json<ChargeResponse>(response)),
    );
    const amounts = new Set(bodies.map((body) => body.uniqueAmount));
    expect(amounts.size).toBe(3);
    for (const body of bodies) {
      expect(body.uniqueAmount).toBeGreaterThan(body.baseAmount);
      expect(body.uniqueAmount - body.baseAmount).toBeLessThanOrEqual(999);
    }
  });

  it("does not reuse a terminal order", async () => {
    ctx = await createTestContext();
    const created = await ctx.json<ChargeResponse>(
      await create("KN-2026-0004"),
    );
    const cancelled = await ctx.request(
      `/v1/charges/${created.chargeId}/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(200);

    const replay = await create("KN-2026-0004");
    expect(replay.status).toBe(409);
    expect(
      (await ctx.json<{ error: { code: string } }>(replay)).error.code,
    ).toBe("ORDER_NOT_REUSABLE");
  });

  it("returns a paid charge on replay", async () => {
    ctx = await createTestContext();
    const created = await ctx.json<ChargeResponse>(
      await create("KN-2026-0005"),
    );
    ctx.fake?.queueTransaction(created.uniqueAmount);
    const reconcile = await ctx.request("/v1/reconcile", { method: "POST" });
    expect(reconcile.status).toBe(200);

    const replay = await create("KN-2026-0005");
    expect(replay.status).toBe(200);
    expect((await ctx.json<ChargeResponse>(replay)).status).toBe("paid");
    expect(ctx.fake?.createCount).toBe(1);
  });

  it("returns 409 when the unique amount pool is exhausted", async () => {
    ctx = await createTestContext({ fakeOptions: { maxOffset: 2 } });
    expect((await create("KN-POOL-A", 50_000)).status).toBe(201);
    expect((await create("KN-POOL-B", 50_000)).status).toBe(201);

    const exhausted = await create("KN-POOL-C", 50_000);
    expect(exhausted.status).toBe(409);
    expect(
      (await ctx.json<{ error: { code: string } }>(exhausted)).error.code,
    ).toBe("AMOUNT_POOL_EXHAUSTED");
  });
});
