import { CaptchaRequiredError, MerchantIdError } from "merchantid";

import { AppError, SessionUnavailableError, isAppError } from "../errors.js";

/**
 * Translate provider/library failures into stable gateway errors.
 *
 * Provider messages and response bodies are deliberately dropped: they can
 * contain provider payloads. The caller logs the original error separately.
 */
export function mapCoreError(error: unknown): Error {
  if (isAppError(error)) return error;

  if (error instanceof CaptchaRequiredError) {
    return new AppError(
      409,
      "SESSION_CAPTCHA_REQUIRED",
      "The provider requires a CAPTCHA; complete login interactively.",
    );
  }

  if (error instanceof MerchantIdError) {
    switch (error.code) {
      case "AMOUNT_POOL_EXHAUSTED":
        return new AppError(
          409,
          "AMOUNT_POOL_EXHAUSTED",
          "No unique payment amount is available right now; retry later.",
        );
      case "AMOUNT_CONFLICT":
        return new AppError(
          409,
          "AMOUNT_CONFLICT",
          "A concurrent charge claimed this amount; retry.",
        );
      case "AUTH_REQUIRED":
        return new SessionUnavailableError();
      case "AUTH_FAILED":
        return new AppError(
          401,
          "SESSION_AUTH_FAILED",
          "OTP verification failed.",
        );
      case "CAPTCHA_REQUIRED":
        return new AppError(
          409,
          "SESSION_CAPTCHA_REQUIRED",
          "The provider requires a CAPTCHA; complete login interactively.",
        );
      case "HTTP_ERROR":
        return new AppError(
          502,
          "PROVIDER_UNAVAILABLE",
          "The payment provider request failed.",
        );
      case "API_ERROR":
        return new AppError(
          502,
          "PROVIDER_ERROR",
          "The payment provider rejected the request.",
        );
      case "QRIS_PARSE_ERROR":
        return new AppError(
          500,
          "QRIS_INVALID",
          "The configured static QRIS is invalid.",
        );
      case "CONFIG_INVALID":
        return new AppError(
          500,
          "PAYMENT_CORE_MISCONFIGURED",
          "The payment core is misconfigured.",
        );
    }
  }

  return new AppError(500, "INTERNAL_ERROR", "Unexpected payment core error.");
}
