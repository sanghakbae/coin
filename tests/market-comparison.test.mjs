import assert from "node:assert/strict";
import test from "node:test";
import { calculateKimchiPremium } from "../src/market-comparison.mjs";

test("calculates the Upbit premium against Binance converted by the USD/KRW rate", () => {
  assert.ok(Math.abs(calculateKimchiPremium(105_000, 100, 1_000) - 5) < 1e-9);
  assert.ok(Math.abs(calculateKimchiPremium(97_000, 100, 1_000) + 3) < 1e-9);
});

test("returns null when any market price is unavailable", () => {
  assert.equal(calculateKimchiPremium(null, 100, 1_000), null);
  assert.equal(calculateKimchiPremium(105_000, 0, 1_000), null);
});
