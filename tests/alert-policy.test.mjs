import assert from "node:assert/strict";
import test from "node:test";
import { getAlertType } from "../scripts/alert-policy.mjs";

test("alerts once when a newly tracked asset already has a buy or sell signal", () => {
  assert.equal(getAlertType(null, { direction: "sell", score: -47, dayChangePercent: -2 }), "signal");
  assert.equal(getAlertType(null, { direction: "buy", score: 40, dayChangePercent: 2 }), "signal");
  assert.equal(getAlertType(null, { direction: "neutral", score: 0, dayChangePercent: 0 }), null);
});

test("does not repeat an unchanged directional signal", () => {
  const previous = { direction: "sell", score: -40, dayChangePercent: -1 };
  assert.equal(getAlertType(previous, { direction: "sell", score: -45, dayChangePercent: -2 }), null);
});

test("detects positive score and 10 percent pump transitions", () => {
  assert.equal(
    getAlertType(
      { direction: "neutral", score: -1, dayChangePercent: 2 },
      { direction: "neutral", score: 1, dayChangePercent: 3 },
    ),
    "positive",
  );
  assert.equal(
    getAlertType(
      { direction: "neutral", score: 2, dayChangePercent: 9.9 },
      { direction: "neutral", score: 3, dayChangePercent: 10 },
    ),
    "pump",
  );
});
