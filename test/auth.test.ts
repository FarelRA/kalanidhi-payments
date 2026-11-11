import { afterEach, describe, expect, it } from "vitest";

import { createTestContext, type TestContext } from "./helpers/context.js";
import { TEST_INTERNAL_KEY } from "./helpers/config.js";

describe("internal API authentication", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.close();
  });

  it("rejects a missing key", async () => {
    ctx = await createTestContext();
    const response = await ctx.rawRequest("/v1/health");
    expect(response.status).toBe(401);
    const body = await ctx.json<{
      error: { code: string; requestId: string };
    }>(response);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(response.headers.get("x-request-id")).toBe(body.error.requestId);
  });

  it("rejects a wrong key, including a different length", async () => {
    ctx = await createTestContext();
    for (const key of [
      "wrong",
      `${TEST_INTERNAL_KEY}x`,
      TEST_INTERNAL_KEY.slice(0, -1),
    ]) {
      const response = await ctx.rawRequest("/v1/health", {
        headers: { "x-internal-key": key },
      });
      expect(response.status).toBe(401);
      const body = await ctx.json<{ error: { code: string } }>(response);
      expect(body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("accepts the correct key", async () => {
    ctx = await createTestContext();
    const response = await ctx.request("/v1/health");
    expect(response.status).toBe(200);
  });

  it("rejects a key in the query string even when the header is valid", async () => {
    ctx = await createTestContext();
    for (const query of [
      "key=abc",
      "api_key=abc",
      "internal_key=abc",
      "token=abc",
    ]) {
      const response = await ctx.request(`/v1/health?${query}`);
      expect(response.status).toBe(401);
      const body = await ctx.json<{ error: { code: string } }>(response);
      expect(body.error.code).toBe("QUERY_KEY_REJECTED");
    }
  });

  it("ignores non-key query parameters", async () => {
    ctx = await createTestContext();
    const response = await ctx.request("/v1/health?verbose=1");
    expect(response.status).toBe(200);
  });

  it("accepts a caller-supplied request id only when it is safe", async () => {
    ctx = await createTestContext();
    const accepted = await ctx.request("/v1/health", {
      headers: { "x-request-id": "req-123.abc" },
    });
    expect(accepted.headers.get("x-request-id")).toBe("req-123.abc");

    const rejected = await ctx.request("/v1/health", {
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(rejected.headers.get("x-request-id")).not.toBe("bad id with spaces");
  });
});
