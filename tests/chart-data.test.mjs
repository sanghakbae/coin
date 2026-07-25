import assert from "node:assert/strict";
import test from "node:test";
import { mergeLiveTodayCandle } from "../src/chart-data.mjs";

const yesterday = {
  openTime: Date.parse("2026-07-24T00:00:00Z"),
  close: 10,
  high: 11,
  low: 9,
  volume: 100,
};

test("adds the current price as today's chart point when today's candle is missing", () => {
  const rows = mergeLiveTodayCandle(
    [yesterday],
    { price: 12, volume: 250 },
    Date.parse("2026-07-25T13:00:00Z"),
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[1].close, 12);
  assert.equal(rows[1].volume, 250);
});

test("updates today's candle instead of adding a duplicate point", () => {
  const today = { ...yesterday, openTime: Date.parse("2026-07-25T00:00:00Z") };
  const rows = mergeLiveTodayCandle(
    [yesterday, today],
    { price: 12, volume: 250 },
    Date.parse("2026-07-25T13:00:00Z"),
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[1].close, 12);
  assert.equal(rows[1].high, 12);
  assert.equal(rows[1].volume, 100);
});
