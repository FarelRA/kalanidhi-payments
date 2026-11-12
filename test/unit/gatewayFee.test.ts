import { describe, expect, it } from "vitest";
import type { Payment } from "merchantid";

import { extractGatewayFee } from "../../src/domain/webhook.js";

function payment(overrides: {
  uniqueAmount?: number;
  raw?: unknown;
  realGrossAmount?: number;
}): Payment {
  return {
    id: "pay_test",
    baseAmount: 10_000,
    uniqueOffset: 1,
    uniqueAmount: overrides.uniqueAmount ?? 10_001,
    status: "paid",
    createdAt: 0,
    expiresAt: 0,
    transaction: {
      id: "trx_test",
      orderId: "order_test",
      merchantId: "G1",
      status: "settlement",
      paymentType: "qris",
      grossAmount: overrides.uniqueAmount ?? 10_001,
      realGrossAmount: overrides.realGrossAmount,
      currency: "IDR",
      transactionTime: "2026-11-12T04:40:00.000Z",
      raw: overrides.raw ?? {},
    },
  };
}

describe("gateway fee extraction", () => {
  it("reads a whole-rupiah fee field", () => {
    expect(extractGatewayFee(payment({ raw: { mdr: 700 } }))).toBe(700);
  });

  it("normalizes a sen-denominated fee once", () => {
    expect(extractGatewayFee(payment({ raw: { fee: 70_000 } }))).toBe(700);
  });

  it("falls back to the difference against realGrossAmount", () => {
    expect(extractGatewayFee(payment({ realGrossAmount: 9_301 }))).toBe(700);
  });

  it("omits the fee when the feed does not report one", () => {
    expect(extractGatewayFee(payment({}))).toBeUndefined();
  });

  it("rejects a fee larger than the payment", () => {
    expect(
      extractGatewayFee(payment({ raw: { fee: 9_999_999 } })),
    ).toBeUndefined();
  });
});
