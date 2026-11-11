import { AsyncLocalStorage } from "node:async_hooks";

interface RequestLogContext {
  requestId: string;
}

/**
 * Carries the current request id into domain/service logs without threading a
 * parameter through every call.
 */
export const requestLogContext = new AsyncLocalStorage<RequestLogContext>();

export function currentRequestId(): string | undefined {
  return requestLogContext.getStore()?.requestId;
}
