import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface ReceivedWebhook {
  body: string;
  headers: IncomingHttpHeaders;
}

export interface WebhookReceiver {
  url: string;
  received: ReceivedWebhook[];
  waitFor(count?: number, timeoutMs?: number): Promise<ReceivedWebhook>;
  close(): Promise<void>;
}

/**
 * Local HTTP receiver for webhook integration tests. Uses no third-party
 * service and binds to 127.0.0.1 on an ephemeral port.
 */
export async function startWebhookReceiver(
  options: {
    statuses?: number[];
  } = {},
): Promise<WebhookReceiver> {
  const received: ReceivedWebhook[] = [];
  const statuses = options.statuses ?? [];
  let statusIndex = 0;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: request.headers,
      });
      const status = statuses[statusIndex] ?? 200;
      statusIndex += 1;
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: status >= 200 && status < 300 }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/api/payments/webhook`,
    received,
    async waitFor(count = 1, timeoutMs = 5_000): Promise<ReceivedWebhook> {
      const started = Date.now();
      while (received.length < count) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(`Timed out waiting for ${count} webhook(s)`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const item = received[count - 1];
      if (!item) throw new Error("Webhook was not received");
      return item;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
