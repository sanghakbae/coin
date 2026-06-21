import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

const TOP_MARKET_CAP_LIMIT = 50;
const CANDLE_LIMIT = 365;
const BUY_THRESHOLD = 50;
const SELL_THRESHOLD = -50;
const PUMP_ALERT_THRESHOLD = 10;
const MAX_ALERTS_PER_RUN = 8;
const SCAN_CONCURRENCY = 4;
const SITE_URL = process.env.SITE_URL || "https://coin.sanghak.kr";
const BINANCE_API_BASES = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];
const EXCLUDED_ASSETS = new Set([
  "USDT",
  "USDC",
  "USDS",
  "DAI",
  "FDUSD",
  "TUSD",
  "USDE",
  "USDD",
  "USDP",
  "PYUSD",
  "USD1",
  "GUSD",
  "FRAX",
  "LUSD",
  "SUSD",
  "BUSD",
  "WBTC",
  "WETH",
  "STETH",
  "WSTETH",
]);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  assertEnv("FIREBASE_SERVICE_ACCOUNT_COIN_F1318");
  assertEnv("KAKAO_REST_API_KEY");
  assertEnv("KAKAO_REFRESH_TOKEN");

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_COIN_F1318);
  if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });

  const db = getFirestore();
  const [coins, tradableSymbols, watchSymbols] = await Promise.all([
    fetchTopMarketCapCoins(),
    fetchBinanceTradingSymbols(),
    fetchWatchSymbols(db),
  ]);
  const universe = coins.filter(
    (coin) =>
      watchSymbols.has(coin.binanceSymbol) &&
      !EXCLUDED_ASSETS.has(coin.symbol) &&
      tradableSymbols.has(coin.binanceSymbol),
  );

  console.log(`watchlist=${watchSymbols.size}, universe=${universe.length}`);
  if (!universe.length) return;

  const rows = await mapLimit(universe, SCAN_CONCURRENCY, async (coin) => {
    const candles = await fetchBinanceCandles(coin.binanceSymbol, "1d", CANDLE_LIMIT);
    return calculateSignal(coin, "1d", candles);
  });
  const signals = rows.sort((left, right) => (left.marketCapRank ?? 999) - (right.marketCapRank ?? 999));

  await saveSignals(db, signals);

  const directional = signals
    .filter((signal) => signal.direction !== "neutral")
    .sort((left, right) => Math.abs(right.score) - Math.abs(left.score))
    .slice(0, MAX_ALERTS_PER_RUN);
  const pump = signals
    .filter((signal) => signal.dayChangePercent !== null && signal.dayChangePercent >= PUMP_ALERT_THRESHOLD)
    .sort((left, right) => Number(right.dayChangePercent) - Number(left.dayChangePercent))
    .slice(0, MAX_ALERTS_PER_RUN);

  for (const signal of directional) await notifyOnDirectionChange(db, signal);
  for (const signal of pump) await notifyOnPump(db, signal);

  for (const signal of signals) {
    await updateCurrentState(db, signal);
    if ((signal.dayChangePercent ?? 0) < PUMP_ALERT_THRESHOLD) await resetPumpState(db, signal);
  }
}

function assertEnv(key) {
  if (!process.env[key]) throw new Error(`Missing required env: ${key}`);
}

async function fetchWatchSymbols(db) {
  const users = await db.collection("users").get();
  const symbols = new Set();

  await Promise.all(
    users.docs.map(async (userDoc) => {
      const watchlist = await userDoc.ref.collection("settings").doc("watchlist").get();
      const rows = watchlist.exists ? watchlist.data()?.symbols : null;
      if (!Array.isArray(rows)) return;

      for (const row of rows) {
        if (typeof row !== "string") continue;
        const symbol = normalizeBinanceSymbol(row);
        if (symbol) symbols.add(symbol);
      }
    }),
  );

  return symbols;
}

function normalizeBinanceSymbol(value) {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return "";
  return cleaned.endsWith("USDT") ? cleaned : `${cleaned}USDT`;
}

async function fetchTopMarketCapCoins() {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", String(TOP_MARKET_CAP_LIMIT));
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");

  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`CoinGecko failed: ${response.status} ${await response.text()}`);

  const rows = await response.json();
  return rows.map((row) => {
    const symbol = String(row.symbol).toUpperCase();
    return {
      id: row.id,
      name: row.name,
      symbol,
      marketCapRank: row.market_cap_rank,
      binanceSymbol: `${symbol}USDT`,
    };
  });
}

async function fetchBinanceTradingSymbols() {
  const data = await fetchBinanceJson("/api/v3/exchangeInfo");
  return new Set(
    data.symbols
      .filter((symbol) => symbol.status === "TRADING" && symbol.quoteAsset === "USDT" && symbol.isSpotTradingAllowed)
      .map((symbol) => symbol.symbol),
  );
}

async function fetchBinanceCandles(symbol, interval, limit) {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));

  const rows = await fetchBinanceJson(`/api/v3/klines${url.search}`);
  return rows.map((row) => ({
    openTime: row[0],
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  }));
}

async function fetchBinanceJson(path) {
  const errors = [];
  for (const base of BINANCE_API_BASES) {
    const response = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
    if (response.ok) return response.json();
    errors.push(`${base} ${response.status}`);
  }
  throw new Error(`Binance request failed: ${errors.join(", ")}`);
}

function calculateSignal(coin, timeframe, candles) {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const price = closes.at(-1) ?? 0;
  const previous = closes.at(-2) ?? price;
  const rsi = calculateRsi(closes);
  const ema50 = calculateEma(closes, 50);
  const ema200 = calculateEma(closes, 200);
  const volumeRatio = ratioToAverage(volumes.at(-1) ?? 0, volumes.slice(-21, -1));
  const dayChangePercent = previous ? ((price - previous) / previous) * 100 : null;
  const trend = ema50 !== null && ema200 !== null ? (price > ema50 && ema50 > ema200 ? 18 : price < ema50 && ema50 < ema200 ? -18 : 0) : 0;
  const rsiScore = rsi === null ? 0 : rsi <= 30 ? 14 : rsi >= 70 ? -14 : rsi > 50 ? 6 : -6;
  const volume = volumeRatio !== null && volumeRatio >= 1.5 ? (price >= previous ? 8 : -8) : 0;
  const pump = dayChangePercent !== null && dayChangePercent >= PUMP_ALERT_THRESHOLD ? 12 : 0;
  const score = Math.round(trend + rsiScore + volume + pump);
  const direction = score >= BUY_THRESHOLD ? "buy" : score <= SELL_THRESHOLD ? "sell" : "neutral";

  return {
    symbol: coin.binanceSymbol,
    asset: coin.symbol,
    coinId: coin.id,
    coinName: coin.name,
    marketCapRank: coin.marketCapRank,
    timeframe,
    direction,
    score,
    reason: explainSignal(direction, { trend, rsi: rsiScore, volume, pump }),
    price,
    dayChangePercent,
    rsi,
    macd: null,
    macdSignal: null,
    macdHistogram: null,
    ema50,
    ema200,
    stochasticK: null,
    stochasticD: null,
    cci: null,
    atrPercent: null,
    bollingerPosition: null,
    volumeRatio,
    obvSlope: null,
    candles: closes.slice(-365),
    candleTimes: candles.map((candle) => candle.openTime).slice(-365),
    newsScore: 0,
    newsArticleCount: 0,
    components: { trend, rsi: rsiScore, volume, pump },
  };
}

async function saveSignals(db, signals) {
  const batch = db.batch();
  const runRef = db.collection("scanRuns").doc();
  batch.set(runRef, {
    source: "github_actions_binance_coingecko",
    universeCount: signals.length,
    signalCount: signals.length,
    createdAt: FieldValue.serverTimestamp(),
  });

  for (const signal of signals) {
    batch.set(db.collection("signals").doc(`${signal.symbol}_${signal.timeframe}`), {
      ...signal,
      runId: runRef.id,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  await batch.commit();
}

async function notifyOnDirectionChange(db, signal) {
  const stateRef = db.collection("state").doc(`${signal.symbol}_${signal.timeframe}`);
  const state = await stateRef.get();
  const data = state.exists ? state.data() : {};

  if (
    data.currentDirection === signal.direction &&
    data.lastNotifiedDirection === signal.direction &&
    Math.abs(signal.score - Number(data.lastNotifiedScore ?? 0)) < 15
  ) {
    return;
  }

  await sendKakaoMemo(signal);
  await stateRef.set(
    {
      currentDirection: signal.direction,
      currentScore: signal.score,
      currentPrice: signal.price,
      currentReason: signal.reason,
      lastNotifiedDirection: signal.direction,
      lastNotifiedScore: signal.score,
      lastNotifiedPrice: signal.price,
      lastNotifiedReason: signal.reason,
      lastNotifiedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function notifyOnPump(db, signal) {
  const stateRef = db.collection("state").doc(`${signal.symbol}_${signal.timeframe}`);
  const state = await stateRef.get();
  const data = state.exists ? state.data() : {};
  const lastPumpPercent = Number(data.lastPumpPercent ?? 0);

  if (data.pumpAlertActive && Math.abs(Number(signal.dayChangePercent ?? 0) - lastPumpPercent) < 3) return;

  await sendKakaoMemo(signal, "pump");
  await stateRef.set(
    {
      pumpAlertActive: true,
      lastPumpPercent: signal.dayChangePercent,
      lastPumpPrice: signal.price,
      lastPumpAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

async function updateCurrentState(db, signal) {
  await db
    .collection("state")
    .doc(`${signal.symbol}_${signal.timeframe}`)
    .set(
      {
        currentDirection: signal.direction,
        currentScore: signal.score,
        currentPrice: signal.price,
        currentReason: signal.reason,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

async function resetPumpState(db, signal) {
  await db
    .collection("state")
    .doc(`${signal.symbol}_${signal.timeframe}`)
    .set(
      {
        pumpAlertActive: false,
        lastPumpResetPercent: signal.dayChangePercent,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

async function sendKakaoMemo(signal, alertType = "signal") {
  const accessToken = await refreshKakaoAccessToken();
  const asset = signal.symbol.endsWith("USDT") ? signal.symbol.slice(0, -4) : signal.symbol;
  const label = alertType === "pump" ? "10% 이상 상승" : signal.direction === "buy" ? "매수 신호" : "하락 위험";
  const detail = alertType === "pump" ? `24시간 상승률: ${round(signal.dayChangePercent)}%` : signal.reason;
  const message = `[${label}] ${asset} ${signal.timeframe}
점수: ${signal.score}
가격: ${signal.price.toLocaleString("ko-KR", { maximumFractionDigits: 6 })} USDT
시총 순위: #${signal.marketCapRank}
${detail}`;

  const response = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body: new URLSearchParams({
      template_object: JSON.stringify({
        object_type: "text",
        text: message,
        link: { web_url: SITE_URL, mobile_web_url: SITE_URL },
      }),
    }),
  });

  if (!response.ok) throw new Error(`Kakao send failed: ${response.status} ${await response.text()}`);
}

async function refreshKakaoAccessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.KAKAO_REST_API_KEY,
    refresh_token: process.env.KAKAO_REFRESH_TOKEN,
  });
  if (process.env.KAKAO_CLIENT_SECRET) body.set("client_secret", process.env.KAKAO_CLIENT_SECRET);

  const response = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
  });
  if (!response.ok) throw new Error(`Kakao token failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  return data.access_token;
}

function explainSignal(direction, components) {
  const base = Object.entries(components)
    .filter(([, value]) => value !== 0)
    .sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))
    .map(([key, value]) => `${key} ${value > 0 ? "+" : ""}${value}`)
    .join(", ");
  if (direction === "buy") return `매수 점수 우위: ${base}`;
  if (direction === "sell") return `하락 위험 점수 우위: ${base}`;
  return `중립: ${base || "뚜렷한 우위 없음"}`;
}

function calculateRsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index] - closes[index - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function calculateEma(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = average(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    ema = (values[index] - ema) * multiplier + ema;
  }
  return ema;
}

function ratioToAverage(value, values) {
  const avg = average(values);
  return avg > 0 ? value / avg : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value) {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
