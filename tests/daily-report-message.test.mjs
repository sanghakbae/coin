import assert from "node:assert/strict";
import test from "node:test";
import { formatDailyReportMessage, getKoreanDateKey, isKoreanReportDue, splitKakaoText } from "../scripts/daily-report-message.mjs";

test("formats all asset decisions into a compact Korean daily report", () => {
  const message = formatDailyReportMessage([
    { asset: "DOT", direction: "neutral", score: -14, price: 0.849, dayChangePercent: 1.68 },
    { asset: "XRP", direction: "sell", score: -43, price: 1.91234, dayChangePercent: -2.5 },
    { asset: "LINK", direction: "buy", score: 35, price: 12.5, dayChangePercent: 0 },
  ], new Date("2026-07-25T13:00:00Z"));

  assert.match(message, /^\[22시 종합 리포트 · Binance USDT\]\n7월 25일/);
  assert.match(message, /DOT 관망 -14 · 0\.849 USDT · \+1\.68%/);
  assert.match(message, /XRP 매도 -43 · 1\.9123 USDT · -2\.5%/);
  assert.match(message, /LINK 매수 \+35 · 12\.5 USDT · 0%/);
});

test("builds the report date key in Asia/Seoul", () => {
  assert.equal(getKoreanDateKey(new Date("2026-07-25T15:30:00Z")), "2026-07-26");
});

test("detects the daily report window in Asia/Seoul", () => {
  assert.equal(isKoreanReportDue(new Date("2026-07-25T12:59:00Z")), false);
  assert.equal(isKoreanReportDue(new Date("2026-07-25T13:00:00Z")), true);
});

test("splits a seven-asset report within Kakao's 200 character limit", () => {
  const signals = ["BTC", "ETH", "DOT", "XRP", "LINK", "AVAX", "ATOM"].map((asset, index) => ({
    asset,
    direction: index === 5 ? "sell" : "neutral",
    score: index === 5 ? -47 : -index,
    price: index < 2 ? 64_123.45 / (index + 1) : 1.2345,
    dayChangePercent: index - 3,
  }));
  const chunks = splitKakaoText(formatDailyReportMessage(signals, new Date("2026-07-25T13:00:00Z")));

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 200));
  assert.match(chunks.join("\n"), /BTC 관망/);
  assert.match(chunks.join("\n"), /ATOM 관망/);
});
