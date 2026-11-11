import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

/**
 * Gateway-owned tables, stored beside the `merchantid` payment tables in the
 * same SQLite file:
 *
 * - `gateway_charges` maps the public charge/order ids onto provider payments.
 * - `gateway_session` holds only the AES-256-GCM envelope, never plaintext.
 * - `gateway_webhook_outbox` is the durable delivery queue and dead-letter log.
 * - `gateway_meta` holds small operational facts such as last reconcile time.
 */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS gateway_charges (
  charge_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  payment_id TEXT NOT NULL UNIQUE,
  base_amount INTEGER NOT NULL CHECK (base_amount > 0),
  unique_amount INTEGER NOT NULL CHECK (unique_amount > 0),
  description TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'paid', 'expired', 'failed', 'cancelled', 'refunded')
  ),
  provider_reference TEXT,
  provider_transaction_id TEXT,
  paid_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  failure_code TEXT,
  qr_string TEXT
);

CREATE INDEX IF NOT EXISTS idx_gateway_charges_status
  ON gateway_charges (status, created_at);
CREATE INDEX IF NOT EXISTS idx_gateway_charges_payment
  ON gateway_charges (payment_id);

CREATE TABLE IF NOT EXISTS gateway_session (
  id TEXT PRIMARY KEY CHECK (id = 'gopay'),
  envelope TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway_webhook_outbox (
  event_id TEXT PRIMARY KEY,
  charge_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (
    type IN ('payment.settled', 'payment.expired', 'payment.failed')
  ),
  payload TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_gateway_webhook_due
  ON gateway_webhook_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS gateway_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface GatewayDatabase {
  readonly raw: DatabaseSync;
  readonly path: string;
  close(): void;
}

export function openGatewayDatabase(path: string): GatewayDatabase {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  // `merchantid/sqlite` owns PRAGMA user_version for its own schema (currently
  // 2), so the gateway tracks its schema in a dedicated table instead of
  // fighting over that single integer.
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    )
  `);
  const existing = db
    .prepare("SELECT version FROM gateway_schema WHERE id = 1")
    .get() as { version: number } | undefined;
  const current = existing ? Number(existing.version) : 0;
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `Database schema ${current} is newer than this build (${SCHEMA_VERSION})`,
    );
  }
  if (current < SCHEMA_VERSION) {
    db.exec(SCHEMA_V1);
    db.prepare(
      `INSERT INTO gateway_schema (id, version) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
    ).run(SCHEMA_VERSION);
  }

  return {
    raw: db,
    path,
    close: () => db.close(),
  };
}
