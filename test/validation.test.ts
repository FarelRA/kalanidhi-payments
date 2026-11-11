import { afterEach, describe, expect, it } from "vitest";

import { createTestContext, type TestContext } from "./helpers/context.js";

describe("request validation", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.close();
  });

  const create = (body: unknown, contentType = "application/json") =>
    ctx.request("/v1/charges", {
      method: "POST",
      headers: { "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("rejects a non-JSON content type", async () => {
    ctx = await createTestContext();
    const response = await create(
      { orderId: "KN-1", baseAmount: 1000 },
      "text/plain",
    );
    expect(response.status).toBe(415);
    expect(
      (await ctx.json<{ error: { code: string } }>(response)).error.code,
    ).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects malformed JSON", async () => {
    ctx = await createTestContext();
    const response = await create("{not json");
    expect(response.status).toBe(400);
    expect(
      (await ctx.json<{ error: { code: string } }>(response)).error.code,
    ).toBe("INVALID_JSON");
  });

  it("rejects an oversized body", async () => {
    ctx = await createTestContext();
    const response = await create({
      orderId: "KN-1",
      baseAmount: 1000,
      description: "x".repeat(20_000),
    });
    expect(response.status).toBe(413);
    expect(
      (await ctx.json<{ error: { code: string } }>(response)).error.code,
    ).toBe("PAYLOAD_TOO_LARGE");
  });

  it("reports field paths without echoing values", async () => {
    ctx = await createTestContext();
    const response = await create({
      orderId: "",
      baseAmount: 10.5,
      expiresInSeconds: 5,
    });
    expect(response.status).toBe(422);
    const body = await ctx.json<{
      error: {
        code: string;
        details: Array<{ path: string; message: string }>;
      };
    }>(response);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    const paths = body.error.details.map((detail) => detail.path);
    expect(paths).toContain("orderId");
    expect(paths).toContain("baseAmount");
    expect(paths).toContain("expiresInSeconds");
    expect(JSON.stringify(body)).not.toContain("10.5");
  });

  it("rejects non-positive and non-integer base amounts", async () => {
    ctx = await createTestContext();
    for (const baseAmount of [0, -1, 1.5, 1_000_000_000_001]) {
      const response = await create({
        orderId: `KN-${baseAmount}`,
        baseAmount,
      });
      expect(response.status).toBe(422);
    }
  });

  it("validates OTP request and verification payloads", async () => {
    ctx = await createTestContext();

    const badPhone = await ctx.request("/v1/session/request-otp", {
      method: "POST",
      body: JSON.stringify({ phoneNumber: "abc" }),
    });
    expect(badPhone.status).toBe(422);

    const badOtp = await ctx.request("/v1/session/verify-otp", {
      method: "POST",
      body: JSON.stringify({ otp: "12", otpToken: "x" }),
    });
    expect(badOtp.status).toBe(422);

    const missingToken = await ctx.request("/v1/session/verify-otp", {
      method: "POST",
      body: JSON.stringify({ otp: "123456" }),
    });
    expect(missingToken.status).toBe(422);
  });

  it("returns a stable 404 for unknown routes and charges", async () => {
    ctx = await createTestContext();

    const route = await ctx.request("/v1/nope");
    expect(route.status).toBe(404);
    expect(
      (await ctx.json<{ error: { code: string } }>(route)).error.code,
    ).toBe("NOT_FOUND");

    const charge = await ctx.request("/v1/charges/ch_missing");
    expect(charge.status).toBe(404);
    expect(
      (await ctx.json<{ error: { code: string } }>(charge)).error.code,
    ).toBe("CHARGE_NOT_FOUND");
  });
});
