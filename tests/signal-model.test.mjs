import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDotSignal } from "../src/signal-model.mjs";

const neutralInput = {
  activeValidators: null,
  adx: null,
  above20w: null,
  atrPercent: null,
  bollingerPosition: null,
  btcRegime: 0,
  change24h: null,
  change7d: null,
  developmentIndex: -1,
  dotBtcChange7d: null,
  etfDayChange: null,
  etfPremiumDiscount: null,
  etfSharesChange5d: null,
  etfVolumeRatio: null,
  fundingRatePercent: null,
  longShortRatio: null,
  macdHistogram: null,
  networkHealthy: null,
  newsBalance: null,
  openInterestChange24h: null,
  priceUp: false,
  rsi: null,
  stakedPercent: null,
  trendState: null,
  volumeRatio: null,
};

test("missing development data stays neutral instead of being penalized", () => {
  const result = evaluateDotSignal(neutralInput);
  assert.equal(result.components.development, 0);
  assert.equal(result.score, 0);
  assert.equal(result.direction, "neutral");
});

test("confirmed bullish trend reaches the buy threshold", () => {
  const result = evaluateDotSignal({
    ...neutralInput,
    above20w: true,
    btcRegime: 1,
    macdHistogram: 1,
    networkHealthy: true,
    trendState: 1,
  });
  assert.equal(result.score, 48);
  assert.equal(result.direction, "buy");
});

test("confirmed bearish trend reaches the risk threshold", () => {
  const result = evaluateDotSignal({
    ...neutralInput,
    above20w: false,
    btcRegime: -1,
    macdHistogram: -1,
    networkHealthy: false,
    trendState: -1,
  });
  assert.equal(result.score, -54);
  assert.equal(result.direction, "risk");
});

test("TDOT share inflow contributes to the composite score", () => {
  const result = evaluateDotSignal({
    ...neutralInput,
    etfDayChange: 1,
    etfPremiumDiscount: 0.2,
    etfSharesChange5d: 2,
    etfVolumeRatio: 2.5,
  });
  assert.equal(result.components.etf, 8);
  assert.equal(result.score, 8);
});

test("normalizes the score into a -100~100 strength over available components only", () => {
  const noData = evaluateDotSignal(neutralInput);
  assert.equal(noData.strength, 0);
  assert.equal(noData.coverage.available, 0);
  assert.equal(noData.coverage.total, 16);

  // Every measurable component points the same way, so the strength saturates
  // even though the raw score is far from the theoretical maximum.
  const allBullish = evaluateDotSignal({
    ...neutralInput,
    above20w: true,
    btcRegime: 1,
    macdHistogram: 1,
    networkHealthy: true,
    trendState: 1,
  });
  assert.equal(allBullish.score, 48);
  assert.equal(allBullish.coverage.available, 5);
  assert.equal(allBullish.scoreRange.positive, 48);
  assert.equal(allBullish.strength, 100);

  // Mixed evidence lands between the bounds.
  const mixed = evaluateDotSignal({
    ...neutralInput,
    above20w: true,
    btcRegime: -1,
    macdHistogram: 1,
    trendState: 1,
  });
  assert.equal(mixed.score, 26);
  assert.equal(mixed.scoreRange.positive, 46);
  assert.equal(mixed.strength, Math.round((26 / 46) * 100));
});

test("strength stays within bounds when every component is at its extreme", () => {
  const maxed = evaluateDotSignal({
    activeValidators: 600,
    adx: 30,
    above20w: true,
    atrPercent: 3,
    bollingerPosition: 1.2,
    btcRegime: 1,
    change24h: 12,
    change7d: 10,
    developmentIndex: 90,
    dotBtcChange7d: 10,
    etfDayChange: 1,
    etfPremiumDiscount: -2,
    etfSharesChange5d: 2,
    etfVolumeRatio: 3,
    fundingRatePercent: -0.06,
    longShortRatio: 0.5,
    macdHistogram: 1,
    networkHealthy: true,
    newsBalance: 5,
    openInterestChange24h: 10,
    priceUp: true,
    rsi: 25,
    stakedPercent: 50,
    trendState: 1,
    volumeRatio: 2,
  });
  assert.equal(maxed.coverage.available, 16);
  assert.equal(maxed.strength, 100);
});

test("tags every reason with the component it came from", () => {
  const result = evaluateDotSignal({
    ...neutralInput,
    above20w: false,
    adx: 15,
    btcRegime: -1,
    trendState: -1,
  });
  assert.deepEqual(result.reasons, result.reasonDetails.map((detail) => detail.text));
  assert.deepEqual(result.reasonDetails.map((detail) => detail.key), ["trend", "sma20w", "btcRegime", "adx"]);

  const quiet = evaluateDotSignal(neutralInput);
  assert.deepEqual(quiet.reasonDetails, [{ key: "none", text: "뚜렷한 방향 우위가 없습니다." }]);
});
