/** Stable application error with an HTTP status and a machine-readable code. */
export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown) {
    super(422, "VALIDATION_ERROR", "Request validation failed", details);
    this.name = "ValidationError";
  }
}

export class SessionUnavailableError extends AppError {
  constructor() {
    super(
      503,
      "SESSION_UNAVAILABLE",
      "No valid GoPay session. Reconnect with OTP before creating or reconciling charges.",
    );
    this.name = "SessionUnavailableError";
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Safe code/message extraction for logs. Never returns `details` or `cause`. */
export function describeError(error: unknown): {
  name: string;
  code?: string;
  message: string;
} {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name,
      ...(typeof code === "string" ? { code } : {}),
      message: error.message,
    };
  }
  return { name: "UnknownError", message: String(error) };
}
