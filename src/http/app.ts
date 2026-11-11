import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

import type { AppLogger } from "../logger.js";
import { AppError, ValidationError, describeError } from "../errors.js";
import { requestLogContext } from "../requestContext.js";
import { mapCoreError } from "../domain/coreErrors.js";
import type { ChargeRecord } from "../domain/types.js";
import type { ChargeService } from "../domain/chargeService.js";
import type { HealthService } from "../domain/health.js";
import type { ReconcileRunner } from "../domain/reconcileRunner.js";
import type { SessionManager } from "../domain/sessionManager.js";

const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_LIKE_QUERY = /key|token|secret/i;
const NO_CONTROL_CHARS = /^[^\p{Cc}]+$/u;

const CreateChargeSchema = z.object({
  orderId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine(
      (value) => NO_CONTROL_CHARS.test(value),
      "contains control characters",
    ),
  baseAmount: z.number().int().positive().max(1_000_000_000_000),
  expiresInSeconds: z.number().int().min(30).max(86_400).optional(),
  description: z.string().trim().max(300).optional(),
});

const PhoneSchema = z
  .string()
  .trim()
  .min(8)
  .max(20)
  .regex(/^\+?[0-9][0-9 -]*$/, "must be a phone number");

const RequestOtpSchema = z.object({ phoneNumber: PhoneSchema });

const VerifyOtpSchema = z.object({
  otp: z
    .string()
    .trim()
    .regex(/^\d{4,10}$/, "must be 4-10 digits"),
  otpToken: z.string().min(1).max(4096),
  phoneNumber: PhoneSchema.optional(),
});

export interface AppDependencies {
  internalKey: string;
  logger: AppLogger;
  charges: ChargeService;
  session: SessionManager;
  runner: ReconcileRunner;
  health: HealthService;
}

type Variables = { requestId: string };

function safeEqual(received: string, expected: string): boolean {
  const a = createHash("sha256").update(received, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function isoOrNull(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

function chargeResponse(charge: ChargeRecord): Record<string, unknown> {
  return {
    chargeId: charge.chargeId,
    orderId: charge.orderId,
    baseAmount: charge.baseAmount,
    uniqueAmount: charge.uniqueAmount,
    description: charge.description,
    status: charge.status,
    qrString: charge.qrString,
    providerReference: charge.providerReference,
    providerTransactionId: charge.providerTransactionId,
    paidAt: isoOrNull(charge.paidAt),
    expiresAt: new Date(charge.expiresAt).toISOString(),
    createdAt: new Date(charge.createdAt).toISOString(),
    failureCode: charge.failureCode,
  };
}

function errorBody(
  c: Context<{ Variables: Variables }>,
  error: AppError,
): { error: Record<string, unknown> } {
  const requestId = c.get("requestId") ?? "unknown";
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
}

/**
 * Parse a JSON body with an explicit size limit and content-type check. Unknown
 * fields are stripped by the schema. Validation details never echo input values.
 */
async function readJson<T>(
  c: Context<{ Variables: Variables }>,
  schema: z.ZodType<T>,
): Promise<T> {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new AppError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
    );
  }

  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  }

  // Enforce the limit while streaming so a chunked body cannot bypass the
  // content-length check and buffer an unbounded payload.
  let text = "";
  const stream = c.req.raw.body;
  if (stream) {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new AppError(
            413,
            "PAYLOAD_TOO_LARGE",
            "Request body is too large.",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    text = Buffer.concat(chunks).toString("utf8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(400, "INVALID_JSON", "Request body is not valid JSON.");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function buildApp(
  deps: AppDependencies,
): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", async (c, next) => {
    const header = c.req.header("x-request-id");
    const requestId =
      header && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");

    const started = performance.now();
    await requestLogContext.run({ requestId }, async () => {
      await next();
    });
    deps.logger.info("request", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });

  // Internal-key auth for every /v1 route. A key in the query string is
  // rejected even when the header is valid: query strings leak through logs,
  // proxies, and browser history.
  app.use("/v1/*", async (c, next) => {
    const url = new URL(c.req.url);
    for (const key of url.searchParams.keys()) {
      if (KEY_LIKE_QUERY.test(key)) {
        throw new AppError(
          401,
          "QUERY_KEY_REJECTED",
          "API keys are not accepted in the query string.",
        );
      }
    }

    const presented = c.req.header("x-internal-key");
    if (!presented || !safeEqual(presented, deps.internalKey)) {
      throw new AppError(
        401,
        "UNAUTHORIZED",
        "Invalid or missing internal key.",
      );
    }
    await next();
  });

  app.post("/v1/charges", async (c) => {
    const input = await readJson(c, CreateChargeSchema);
    const result = await deps.charges.create(input);
    return c.json(chargeResponse(result.charge), result.created ? 201 : 200);
  });

  app.get("/v1/charges/:id", (c) => {
    const charge = deps.charges.get(c.req.param("id"));
    return c.json(chargeResponse(charge));
  });

  app.post("/v1/charges/:id/cancel", async (c) => {
    const charge = await deps.charges.cancel(c.req.param("id"));
    return c.json(chargeResponse(charge));
  });

  app.post("/v1/reconcile", async (c) => {
    const outcome = await deps.runner.run();
    if (!outcome.ran) {
      throw new AppError(
        409,
        "RECONCILE_IN_PROGRESS",
        "A reconcile tick is already running.",
      );
    }
    return c.json(outcome.summary);
  });

  app.get("/v1/health", (c) => {
    return c.json(deps.health.snapshot());
  });

  app.post("/v1/session/request-otp", async (c) => {
    const input = await readJson(c, RequestOtpSchema);
    const result = await deps.session.requestOtp(input.phoneNumber);
    return c.json({ otpToken: result.otpToken });
  });

  app.post("/v1/session/verify-otp", async (c) => {
    const input = await readJson(c, VerifyOtpSchema);
    const status = await deps.session.verifyOtp(input);
    return c.json({
      status: status.status,
      expiresAt: isoOrNull(status.expiresAt ?? null),
    });
  });

  app.get("/v1/session/status", (c) => {
    const status = deps.session.status();
    return c.json({
      status: status.status,
      expiresAt: isoOrNull(status.expiresAt ?? null),
      updatedAt: isoOrNull(status.updatedAt ?? null),
    });
  });

  app.notFound((c) => {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Route not found.",
          requestId: c.get("requestId") ?? "unknown",
        },
      },
      404,
    );
  });

  app.onError((error, c) => {
    const mapped =
      error instanceof AppError ? error : (mapCoreError(error) as AppError);
    const appError =
      mapped instanceof AppError
        ? mapped
        : new AppError(500, "INTERNAL_ERROR", "Internal server error.");
    const described = describeError(error);

    if (appError.status >= 500) {
      deps.logger.error("request failed", {
        requestId: c.get("requestId"),
        code: appError.code,
        name: described.name,
        causeCode: described.code,
      });
    } else {
      deps.logger.warn("request rejected", {
        requestId: c.get("requestId"),
        code: appError.code,
      });
    }

    return c.json(
      errorBody(c, appError),
      appError.status as ContentfulStatusCode,
    );
  });

  return app;
}
