# KalaNidhi payments gateway

Private, headless HTTP service that turns a GoPay/GoBiz merchant session into
charge creation, unique-amount allocation, reconciliation, and signed webhooks
for KalaNidhi.

There is no UI, no admin panel, and no public route. The service is designed to
be called only by the KalaNidhi Next.js server over a private network.

> **Unofficial provider warning.** The GoPay/GoBiz adapter uses private,
> undocumented merchant endpoints. Use it only with merchant accounts you own
> and are authorized to automate. It is not affiliated with GoPay, GoBiz,
> Gojek, or Shopee. Review the provider agreement, tax, and legal implications
> before moving real money.

## Architecture

```text
Next.js / Convex  ── private HTTP + x-internal-key ──►  payments gateway
                                                         │
                                                         ├─ merchantid payment core
                                                         ├─ SQLite (charges, claims, quarantine)
                                                         ├─ AES-256-GCM session vault
                                                         └─ signed webhook outbox
                                                                 │
                                                                 ▼
                                                      Next.js webhook endpoint
```

Convex remains the business system of record. This gateway owns only provider
charges, unique amounts, QRIS payloads, sessions, transaction claims, and its
own delivery outbox.

## Requirements

- Node 24 (`node:sqlite` is required by `merchantid/sqlite`; it is still marked
  experimental by Node, so pin the runtime image).
- No database server. SQLite lives on a local filesystem.
- One instance. Do not scale replicas: there is a single reconciler and a
  single writer.

## Quick start

```sh
cp .env.example .env
# Fill in real values. At minimum:
#   SESSION_VAULT_PASSPHRASE, GOPAY_MERCHANT_ID, GOPAY_STATIC_QRIS,
#   INTERNAL_API_KEY, WEBHOOK_URL, WEBHOOK_SECRET
npm ci
npm run build
node dist/index.js
```

Health:

```sh
curl -sS -H "x-internal-key: $INTERNAL_API_KEY" \
  http://127.0.0.1:8080/v1/health | jq
```

```json
{
  "status": "degraded",
  "version": "0.1.0",
  "uptimeSeconds": 3,
  "session": "missing",
  "pendingCharges": 0,
  "lastReconcileAt": null,
  "lastReconcileDurationMs": null,
  "lastReconcileFailedAt": null,
  "reconcilerRunning": false
}
```

`session: missing` is expected on a fresh volume. Connect the merchant session
once with the OTP endpoints; the encrypted session survives restarts.

## Authentication

Every `/v1` route requires:

```text
x-internal-key: <INTERNAL_API_KEY>
```

Comparison is constant-time. A key in the query string is rejected even when
the header is valid (`QUERY_KEY_REJECTED`), because query strings leak through
proxies, access logs, and browser history. Do not add CORS or a public route.

Errors are JSON with a stable code and the request id:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "requestId": "0c5a4f69-b8ed-4ce3-95a6-ad03574eb8a6",
    "details": [{ "path": "baseAmount", "message": "Too small" }]
  }
}
```

`x-request-id` is echoed on every response. A safe caller-supplied value is
kept; otherwise the gateway generates a UUID.

## API

### Create a charge

```sh
curl -sS -X POST http://127.0.0.1:8080/v1/charges \
  -H "x-internal-key: $INTERNAL_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "orderId": "KN-2026-000123",
    "baseAmount": 1450000,
    "expiresInSeconds": 900,
    "description": "Batik Tulis Soga"
  }'
```

`201 Created` on first create, `200 OK` when the same `orderId` and
`baseAmount` already exist (`pending` or `paid`). A different amount for the
same order is `409 ORDER_AMOUNT_MISMATCH`. An expired/cancelled/failed order is
`409 ORDER_NOT_REUSABLE`; use a new order id rather than reusing a paid or
terminal one.

```json
{
  "chargeId": "ch_9f1c...",
  "orderId": "KN-2026-000123",
  "baseAmount": 1450000,
  "uniqueAmount": 1450037,
  "description": "Batik Tulis Soga",
  "status": "pending",
  "qrString": "000201...",
  "providerReference": null,
  "providerTransactionId": null,
  "paidAt": null,
  "expiresAt": "2026-11-11T16:15:00.000Z",
  "createdAt": "2026-11-11T16:00:00.000Z",
  "failureCode": null
}
```

The buyer must transfer **`uniqueAmount` exactly**. The offset is 1–999 rupiah,
is not platform revenue, and is disclosed at checkout. The 70/15/15 split is
calculated from `baseAmount`.

#### Idempotency details

- `orderId` is unique in the gateway database.
- Concurrent creates for the same order are serialized in-process and protected
  by a unique index.
- A crash between the payment-core write and the charge index write leaves a
  pending payment with no charge. The next reconcile expires it through the
  normal core path; no webhook is emitted for it.
- `expiresInSeconds` is limited to 30–86400; the default is `600`.

### Get a charge

```sh
curl -sS -H "x-internal-key: $INTERNAL_API_KEY" \
  http://127.0.0.1:8080/v1/charges/ch_9f1c...
```

Reads the gateway's stored status only. It does **not** poll GoPay. Provider
polling happens only in `tick()`, from the scheduler or `POST /v1/reconcile`.

Statuses: `pending`, `paid`, `expired`, `failed`, `cancelled`, `refunded`.
`refunded` exists for future ledger integration; this service does not perform
provider refunds.

### Cancel a charge

```sh
curl -sS -X POST -H "x-internal-key: $INTERNAL_API_KEY" \
  http://127.0.0.1:8080/v1/charges/ch_9f1c.../cancel
```

Only a pending charge can be cancelled. If settlement wins the race, the
response is `409 CHARGE_NOT_PENDING` with `details.status = "paid"`.
Cancellation does not emit a webhook.

### Reconcile once

```sh
curl -sS -X POST -H "x-internal-key: $INTERNAL_API_KEY" \
  http://127.0.0.1:8080/v1/reconcile
```

Runs exactly one `tick()`, repairs local charge statuses from the durable core
store, and delivers due webhooks.

```json
{
  "ran": true,
  "paid": 1,
  "expired": 0,
  "webhooksDelivered": 1,
  "webhooksRetrying": 0,
  "webhooksDeadLettered": 0,
  "durationMs": 84,
  "completedAt": "2026-11-11T16:01:00.000Z"
}
```

If a tick is already running, the response is
`409 RECONCILE_IN_PROGRESS`. The scheduler also refuses overlapping ticks.

### Health

`GET /v1/health` returns the session state (`valid`, `expired`, `missing`),
pending charge count, last successful reconcile time, uptime, and whether a
reconcile is running. It never returns tokens, the vault key, QRIS payloads,
phone numbers, or file paths.

`status` is `degraded` whenever the session is not `valid`; the HTTP status
stays `200` so a container healthcheck does not restart a gateway that only
needs OTP reconnection. Alert on `session != valid`.

## Sessions and OTP

OTP login is an operator action, not a buyer flow. It has no UI and is audited
only through structured logs (never the OTP or token).

```sh
curl -sS -X POST http://127.0.0.1:8080/v1/session/request-otp \
  -H "x-internal-key: $INTERNAL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"phoneNumber":"+6281234567890"}'

curl -sS -X POST http://127.0.0.1:8080/v1/session/verify-otp \
  -H "x-internal-key: $INTERNAL_API_KEY" \
  -H "content-type: application/json" \
  -d '{"otp":"123456","otpToken":"<value from request-otp>"}'

curl -sS -H "x-internal-key: $INTERNAL_API_KEY" \
  http://127.0.0.1:8080/v1/session/status
```

- The OTP challenge token and OTP are never logged.
- Verification runs on a scratch provider; the session is sealed with
  AES-256-GCM and written to SQLite **before** the live provider adopts it. A
  vault write failure leaves the old session untouched.
- Token refreshes persist the rotated session before the new token is used.
- Envelope AAD is bound to `kalanidhi-payments/gopay-session/v1`.
- Keep `SESSION_VAULT_PASSPHRASE` in a secret manager, not on the SQLite volume.
  Losing it means re-authenticating with OTP; changing it makes existing
  envelopes fail closed (`session: missing`).

Charge creation, cancellation, and reconciliation return
`503 SESSION_UNAVAILABLE` while the session is missing or unauthenticated. This
matches the design contract: QR generation pauses until an operator reconnects.

## Webhooks

The gateway sends exactly three event types:

- `payment.settled` — a provider transaction matched a charge.
- `payment.expired` — a pending charge passed its expiry plus clock skew.
- `payment.failed` — **application-level only** (for example an operator rejects
  an unpaid order). There is no public route for it in v1; `ChargeService`
  exposes an internal `markFailed()` for a future audited admin integration. It
  cancels the pending core payment first, then records the failure and emits the
  event. It is never emitted for a provider refund or a settlement failure.

The core has no `failed` payment status, so `payment.failed` is built by the
gateway rather than by `createPaymentWebhookEvent()`.

### Payload

```json
{
  "id": "ch_9f1c...:payment.settled",
  "type": "payment.settled",
  "createdAt": "2026-11-11T16:02:11.000Z",
  "event": "payment.settled",
  "eventId": "ch_9f1c...:payment.settled",
  "chargeId": "ch_9f1c...",
  "orderId": "KN-2026-000123",
  "providerTransactionId": "TRX-...",
  "amount": 1450037,
  "paidAt": "2026-11-11T16:02:11.000Z",
  "data": {
    "paymentId": "pay_...",
    "reference": "KN-2026-000123",
    "status": "paid",
    "baseAmount": 1450000,
    "uniqueOffset": 37,
    "uniqueAmount": 1450037,
    "createdAt": "2026-11-11T16:00:00.000Z",
    "expiresAt": "2026-11-11T16:15:00.000Z",
    "scope": { "provider": "gopay", "merchantId": "G000000001" },
    "transaction": {
      "id": "TRX-...",
      "orderId": "QRIS-...",
      "status": "SETTLEMENT",
      "grossAmount": 1450037,
      "transactionTime": "2026-11-11T16:02:10+07:00"
    }
  }
}
```

The payload deliberately excludes `qrString`, session tokens, OTPs, raw provider
rows, and customer data. `paidAt` is `null` for expired and failed events.

### Headers

```text
X-MerchantId-Event: payment.settled
X-MerchantId-Event-Id: ch_9f1c...:payment.settled
X-MerchantId-Idempotency-Key: ch_9f1c...:payment.settled
X-MerchantId-Signature: t=1762855331,v1=<hex hmac>
X-Kalanidhi-Event: payment.settled
X-Kalanidhi-Event-Id: ch_9f1c...:payment.settled
X-Kalanidhi-Timestamp: 1762855331
X-Kalanidhi-Signature: sha256=<hex hmac>
```

Both signatures cover the exact JSON body. The library signature is
HMAC-SHA256 over `${t}.${rawBody}`. The KalaNidhi header uses the same material
with a `sha256=` prefix. The event id is stable and doubles as the idempotency
key.

Verify with the library (recommended):

```ts
import { verifyWebhookSignature } from "merchantid/webhook";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-merchantid-signature") ?? "";
  const valid = verifyWebhookSignature({
    body: rawBody,
    signatureHeader: signature,
    secret: process.env.WEBHOOK_SECRET!,
    toleranceSeconds: 300,
  });
  if (!valid) return new Response("unauthorized", { status: 401 });

  const event = JSON.parse(rawBody);
  // Deduplicate on event.eventId (or X-MerchantId-Idempotency-Key) before
  // calling the idempotent Convex mutation.
  return Response.json({ ok: true });
}
```

Or verify the KalaNidhi header directly with a constant-time compare:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const timestamp = request.headers.get("x-kalanidhi-timestamp") ?? "";
const provided = (request.headers.get("x-kalanidhi-signature") ?? "").replace(
  /^sha256=/,
  "",
);
const expected = createHmac("sha256", process.env.WEBHOOK_SECRET!)
  .update(`${timestamp}.${rawBody}`)
  .digest("hex");
if (
  provided.length !== expected.length ||
  !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
) {
  return new Response("unauthorized", { status: 401 });
}
```

### Delivery, retries, dead letters

- One attempt per reconcile pass; exponential backoff with jitter between
  attempts; 8 attempts by default (`WEBHOOK_MAX_ATTEMPTS`).
- The event id, idempotency key, and body are identical on every attempt.
- Successful attempts are marked `delivered`; exhausted events are marked `dead`
  and logged with `eventId`, `chargeId`, `type`, attempt count, and error code.
- A webhook URL that fails SSRF/HTTPS validation is dead-lettered immediately;
  it is a configuration error, not a transient failure.
- Redirects are not followed, and the library rejects loopback/private/
  link-local/reserved destinations unless
  `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` (local development only).
- Deliveries run inside the single reconciler. This is intentional: one writer,
  one delivery worker.

Inspect the outbox:

```sh
sqlite3 /var/lib/kalanidhi/payments.sqlite \
  "select event_id, status, attempts, last_error from gateway_webhook_outbox order by created_at desc limit 20;"
```

## Payments and reconciliation behavior

- Unique amounts are allocated by `merchantid`: smallest free offset in
  `[1, MAX_UNIQUE_OFFSET]` (default 999). Uniqueness is enforced on the final
  amount in SQLite, including across process restarts.
- Freed amounts are quarantined for `2 * CLOCK_SKEW_MS`. Run NTP; the clock is
  part of the safety argument.
- Settlement is fail-closed: exact `uniqueAmount`, allow-listed status, valid
  timestamp inside `createdAt - skew .. expiresAt + skew`, transaction id
  claimed at most once, payment still pending.
- Match-before-expire ordering is preserved: a transaction indexed just after
  expiry can still settle if it belongs to the payment window.
- A tick fetches the provider feed once, settles matches, then expires stale
  payments. Feed failures do not prevent expiry.
- `GET /v1/charges/:id` never polls. A scheduler runs every
  `RECONCILE_INTERVAL_MS` with symmetric jitter, and never overlaps.
- Late payments after expiry are **not** auto-settled. They remain unclaimed and
  require manual reconciliation; there is no unmatched-transfer queue in v1.
- Refunds are **manual**. This service has no provider refund call. Refund from
  the GoBiz dashboard against the original transaction, keep the charge `paid`,
  and record the reversal in the KalaNidhi ledger with payment id, transaction
  id, amount, reason, operator, and timestamp. Do not send a second
  `payment.settled` event.
- `payment.failed` is for application-level rejection, not a settlement status.

## Security notes

- **Network:** no public Traefik route. Bind to `127.0.0.1` or an internal
  network. Compose exposes the port only on `kalanidhi-internal`.
- **Secrets:** internal key, webhook secret, vault passphrase, and provider
  session are never written to the image or repository. `.env` is ignored and
  excluded from Docker context.
- **Logging:** structured JSON; request id on every request and error. Bodies,
  query strings, headers, OTPs, tokens, QRIS payloads, and envelope contents are
  never logged. Sensitive log keys are redacted defensively.
- **Encryption:** session envelopes are AES-256-GCM with a fresh 12-byte IV and
  scrypt-derived key (16-byte random salt in the envelope). The database holds
  ciphertext only.
- **Auth:** `x-internal-key` with SHA-256 + `timingSafeEqual`; query keys are
  rejected. There is no user login, cookie, or CSRF surface.
- **SSRF:** webhook URLs are HTTPS-only, credentials are rejected, DNS is
  resolved, and private/reserved targets are blocked. Residual DNS-rebinding
  risk remains between validation and `fetch`; pair this with an egress
  firewall or allow-listed proxy.
- **Input limits:** JSON bodies are capped at 16 KiB; charge ids, order ids,
  amounts, expiry, and descriptions are validated. Unknown body fields are
  stripped.
- **No rate limiter:** acceptable only because the service is private. If it is
  ever reachable from a broader network, add a gateway-level rate limit.
- **Single writer:** SQLite + one reconciler. Do not run two replicas against
  the same merchant feed. Horizontal scaling needs a shared store, a leader
  election, and a shared delivery worker.

## Deployment

### Docker (recommended)

```sh
cp .env.example .env
# edit .env with real values
docker compose up --build -d
docker compose logs -f payments
```

The image is multi-stage `node:24-alpine`:

- Build stage installs dev dependencies, compiles TypeScript, then prunes to
  production dependencies.
- Runtime stage runs as the non-root `app` user, contains no source, no `.env`,
  and no secrets. Current dirs are read-only in compose; `/tmp` is a tmpfs and
  `/var/lib/kalanidhi` is the named volume.
- The healthcheck calls `/v1/health` with the runtime internal key; the key is
  not baked into the image. Some OCI image exporters ignore the legacy
  `HEALTHCHECK` instruction, so `docker-compose.yml` defines the same probe
  explicitly. Non-compose runtimes should configure an equivalent HTTP probe.
- Compose publishes no host port and joins only `kalanidhi-internal`.

The `merchantid` dependency is a **vendored `npm pack` tarball** from the pinned
commit. The fork does not commit `dist/` and has no `prepare` script, so a git
dependency would install without build output. Vendoring also means neither git
nor GitHub access is needed at image build time. Provenance and SHA-256 are in
[`vendor/README.md`](vendor/README.md).

### Bare Node

```sh
npm ci
npm run verify
NODE_ENV=production HOST=127.0.0.1 PORT=8080 \
STORE_PATH=/var/lib/kalanidhi/payments.sqlite \
node dist/index.js
```

Run under systemd or a supervisor with `Restart=always`, a non-root user, and
the environment loaded from a secret manager. Mount the SQLite directory on a
local filesystem, not NFS/SMB.

### Backup and recovery

- Back up `payments.sqlite` (and its `-wal`/`-shm` siblings if the process is
  running) on a schedule. Use SQLite's online backup API or stop the gateway
  before copying.
- The vault passphrase is **not** in the database. Store it separately; without
  it the session must be re-established by OTP.
- To restore: stop the gateway, restore the database and matching passphrase,
  start the gateway, and check `GET /v1/session/status`.

## Testing

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

The suite uses `FakePaymentsCore` for API/lifecycle/webhook tests and the real
`merchantid` `PaymentService` + `SqlitePaymentStore` with a fake transaction
feed for restart/claim tests. **No test calls GoPay.** Tests cover:

- internal-key auth, query-key rejection, request ids (including request-scoped
  domain logs);
- JSON/content-type/size/field validation;
- order-id idempotency, amount conflicts, concurrent creates;
- unique amounts, cancellation races, settlement, expiry, application failure;
- reconcile overlap, summaries, scheduler jitter and stop behavior;
- health shape, session states, redaction and no-secret assertions;
- webhook signature verification, payload shape, retry/backoff, dead letters,
  SSRF rejection;
- vault persistence and ciphertext-only storage;
- restart persistence of charges, transaction claims, quarantine, and last
  reconcile time.

## API error codes

| HTTP | Code                                      | Meaning                                   |
| ---- | ----------------------------------------- | ----------------------------------------- |
| 400  | `INVALID_JSON`                            | Body is not valid JSON.                   |
| 401  | `UNAUTHORIZED`                            | Missing or wrong internal key.            |
| 401  | `QUERY_KEY_REJECTED`                      | Key-like query parameter supplied.        |
| 401  | `SESSION_AUTH_FAILED`                     | OTP verification failed.                  |
| 404  | `NOT_FOUND`                               | Unknown route.                            |
| 404  | `CHARGE_NOT_FOUND`                        | Unknown charge id.                        |
| 409  | `ORDER_AMOUNT_MISMATCH`                   | Same order id, different base amount.     |
| 409  | `ORDER_NOT_REUSABLE`                      | Existing charge is terminal.              |
| 409  | `CHARGE_NOT_PENDING`                      | Cancel attempted after settlement/expiry. |
| 409  | `RECONCILE_IN_PROGRESS`                   | A tick is already running.                |
| 409  | `AMOUNT_POOL_EXHAUSTED`                   | No free offset in the window.             |
| 409  | `AMOUNT_CONFLICT`                         | Concurrent allocation conflict; retry.    |
| 409  | `SESSION_CAPTCHA_REQUIRED`                | Provider requires interactive CAPTCHA.    |
| 413  | `PAYLOAD_TOO_LARGE`                       | Body exceeds 16 KiB.                      |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                  | Missing/!= `application/json`.            |
| 422  | `VALIDATION_ERROR`                        | Field validation failed.                  |
| 500  | `INTERNAL_ERROR`                          | Unexpected server error.                  |
| 502  | `PROVIDER_ERROR` / `PROVIDER_UNAVAILABLE` | Provider rejected/failed.                 |
| 503  | `SESSION_UNAVAILABLE`                     | No authenticated GoPay session.           |

## Known limitations and remaining risks

1. **No live provider test.** All GoPay/Shopee behavior is exercised with
   fixtures and fakes. Run one small real transaction against the merchant
   account before production.
2. **Unofficial private endpoints.** GoPay/GoBiz can change or remove them.
   Keep the internal API stable so an official provider adapter can replace it.
3. **No provider refunds.** Refunds are manual; see above.
4. **Late payments after expiry.** No unmatched-transfer queue in v1. A late
   payment needs operator resolution in GoBiz and a ledger adjustment.
5. **DNS rebinding residual risk.** URL validation and `fetch` resolve DNS
   separately. Use an egress firewall or allow-listed proxy.
6. **`payment.failed` is application-level.** It has no public trigger yet and
   is never a settlement outcome.
7. **Single-instance SQLite.** WAL is local-filesystem only. Do not put the
   volume on a network share or run multiple replicas.
8. **Clock dependence.** Quarantine and matching windows use wall-clock time.
   Run NTP and keep `CLOCK_SKEW_MS` conservative (30–120 s).
9. **`node:sqlite` is experimental.** Pin the Node runtime and re-run the test
   suite when upgrading.
10. **No automated load/chaos suite.** The design is low-volume (private
    checkout); add load tests before any high-concurrency use.
11. **No webhook replay endpoint.** Dead-lettered events are inspectable in
    SQLite; replay is an operator action in v1.
12. **Unbounded operational tables.** `gateway_webhook_outbox` and
    `gateway_charges` grow forever. Prune `delivered`/`dead` outbox rows and
    old terminal charges on a schedule after your dispute/retention window.

## License and attribution

This service is MIT-licensed (see `LICENSE`). It depends on the MIT-licensed
[`merchantid`](https://github.com/alhifnywahid/merchantid) fork
[`FarelRA/merchantid@kalanidhi-hardening`](https://github.com/FarelRA/merchantid/tree/kalanidhi-hardening)
at `db51ed9a9ae1db0a0fe1f0bf1665dcfd41e760b6`. Keep the upstream copyright and
license notice in redistributions. The fork is unofficial and provided as-is,
without warranty; review it against your provider agreement and threat model
before moving real money.
