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
  newsBalance: 0,
  openInterestChange24h: null,
  priceUp: false,
  rsi: null,
  stakedPercent: null,
  trendState: 0,
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
