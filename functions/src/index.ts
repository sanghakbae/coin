import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";

initializeApp();

const kakaoRestApiKey = defineSecret("KAKAO_REST_API_KEY");
const kakaoRefreshToken = defineSecret("KAKAO_REFRESH_TOKEN");
const siteUrl = defineSecret("SITE_URL");

type Direction = "buy" | "sell" | "neutral";

interface MarketCoin {
  id: string;
  name: string;
  symbol: string;
  marketCapRank: number;
  marketCap: number;
  binanceSymbol: string;
}

interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  takerBuyQuoteVolume: number;
}

interface NewsScore {
  score: number;
  articleCount: number;
  positiveCount: number;
  negativeCount: number;
  sampleTitles: string[];
}

interface Signal {
  symbol: string;
  asset: string;
  coinId: string;
  coinName: string;
  marketCapRank: number;
  timeframe: string;
  direction: Direction;
  score: number;
  reason: string;
  price: number;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  ema50: number | null;
  ema200: number | null;
  stochasticK: number | null;
  stochasticD: number | null;
  cci: number | null;
  atrPercent: number | null;
  bollingerPosition: number | null;
  volumeRatio: number | null;
  obvSlope: number | null;
  newsScore: number;
  newsArticleCount: number;
  components: Record<string, number>;
  createdAt?: FirebaseFirestore.FieldValue;
}

const TIMEFRAMES = ["15m", "1h", "4h"];
const TOP_MARKET_CAP_LIMIT = 50;
const CANDLE_LIMIT = 240;
const BUY_THRESHOLD = 42;
const SELL_THRESHOLD = -42;
const MAX_ALERTS_PER_RUN = 5;
const SCAN_CONCURRENCY = 5;
const EXCLUDED_ASSETS = new Set([
  "USDT",
  "USDC",
  "DAI",
  "FDUSD",
  "TUSD",
  "USDE",
  "USDD",
  "BUSD",
  "WBTC",
  "WETH",
  "STETH",
  "WSTETH",
]);

export const scanCoinSignals = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Asia/Seoul",
    secrets: [kakaoRestApiKey, kakaoRefreshToken, siteUrl],
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const db = getFirestore();
    const [coins, tradableSymbols] = await Promise.all([fetchTopMarketCapCoins(), fetchBinanceTradingSymbols()]);
    const universe = coins.filter((coin) => !EXCLUDED_ASSETS.has(coin.symbol) && tradableSymbols.has(coin.binanceSymbol));

    logger.info("Signal scan universe prepared", {
      topMarketCap: coins.length,
      binanceTradable: universe.length,
    });

    const scanResults = await mapLimit(universe, SCAN_CONCURRENCY, async (coin) => {
      try {
        return await scanCoin(coin);
      } catch (error) {
        logger.warn("Coin scan failed", { symbol: coin.binanceSymbol, error });
        return [];
      }
    });

    const latestSignals = scanResults.flat();
    const ranked = latestSignals
      .sort((left, right) => Math.abs(right.score) - Math.abs(left.score))
      .slice(0, TOP_MARKET_CAP_LIMIT * TIMEFRAMES.length);
    const batch = db.batch();
    const runRef = db.collection("scanRuns").doc();

    batch.set(runRef, {
      source: "binance_coingecko_gdelt",
      topMarketCapLimit: TOP_MARKET_CAP_LIMIT,
      timeframes: TIMEFRAMES,
      universeCount: universe.length,
      signalCount: ranked.length,
      createdAt: FieldValue.serverTimestamp(),
    });

    for (const signal of ranked) {
      const signalRef = db.collection("signals").doc(`${signal.symbol}_${signal.timeframe}`);
      batch.set(signalRef, {
        ...signal,
        runId: runRef.id,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();

    const actionable = ranked
      .filter((signal) => signal.direction !== "neutral")
      .slice(0, MAX_ALERTS_PER_RUN);

    for (const signal of actionable) {
      await notifyOnDirectionChange(signal);
    }
  },
);

async function scanCoin(coin: MarketCoin): Promise<Signal[]> {
  const news = await fetchNewsScore(coin);
  const results: Signal[] = [];

  for (const timeframe of TIMEFRAMES) {
    const candles = await fetchBinanceCandles(coin.binanceSymbol, timeframe, CANDLE_LIMIT);
    results.push(calculateSignal(coin, timeframe, candles, news));
  }

  return results;
}

async function fetchTopMarketCapCoins(): Promise<MarketCoin[]> {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", String(TOP_MARKET_CAP_LIMIT));
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");

  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`CoinGecko markets request failed: ${response.status} ${await response.text()}`);
  }

  const rows = (await response.json()) as Array<{
    id: string;
    name: string;
    symbol: string;
    market_cap_rank: number;
    market_cap: number;
  }>;

  return rows.map((row) => {
    const asset = row.symbol.toUpperCase();
    return {
      id: row.id,
      name: row.name,
      symbol: asset,
      marketCapRank: row.market_cap_rank,
      marketCap: row.market_cap,
      binanceSymbol: `${asset}USDT`,
    };
  });
}

async function fetchBinanceTradingSymbols() {
  const response = await fetch("https://api.binance.com/api/v3/exchangeInfo", {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Binance exchangeInfo request failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as {
    symbols: Array<{
      symbol: string;
      status: string;
      quoteAsset: string;
      isSpotTradingAllowed: boolean;
    }>;
  };

  return new Set(
    data.symbols
      .filter((symbol) => symbol.status === "TRADING" && symbol.quoteAsset === "USDT" && symbol.isSpotTradingAllowed)
      .map((symbol) => symbol.symbol),
  );
}

async function fetchBinanceCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));

  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Binance klines request failed: ${response.status} ${await response.text()}`);
  }

  const rows = (await response.json()) as Array<
    [
      number,
      string,
      string,
      string,
      string,
      string,
      number,
      string,
      number,
      string,
      string,
      string,
    ]
  >;

  return rows.map((row) => ({
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    quoteVolume: Number(row[7]),
    takerBuyQuoteVolume: Number(row[10]),
  }));
}

async function fetchNewsScore(coin: MarketCoin): Promise<NewsScore> {
  const query = encodeURIComponent(`"${coin.name}" OR ${coin.symbol} cryptocurrency`);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=artlist&format=json&maxrecords=20&timespan=24h`;

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      logger.warn("GDELT news request failed", { coin: coin.symbol, status: response.status });
      return emptyNewsScore();
    }

    const data = (await response.json()) as {
      articles?: Array<{ title?: string }>;
    };
    const titles = (data.articles ?? []).map((article) => article.title ?? "").filter(Boolean);
    return scoreNewsTitles(titles);
  } catch (error) {
    logger.warn("GDELT news score failed", { coin: coin.symbol, error });
    return emptyNewsScore();
  }
}

function calculateSignal(coin: MarketCoin, timeframe: string, candles: Candle[], news: NewsScore): Signal {
  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const volumes = candles.map((candle) => candle.volume);
  const price = closes.at(-1) ?? 0;
  const rsi = last(rsiSeries(closes, 14));
  const macdRows = macdSeries(closes, 12, 26, 9);
  const macdNow = macdRows.at(-1);
  const macdPrev = macdRows.at(-2);
  const ema50Series = emaSeries(closes, 50);
  const ema200Series = emaSeries(closes, 200);
  const ema50 = last(ema50Series);
  const ema200 = last(ema200Series);
  const stochasticRows = stochasticSeries(highs, lows, closes, 14, 3);
  const stochastic = stochasticRows.at(-1);
  const stochasticPrev = stochasticRows.at(-2);
  const cci = last(cciSeries(highs, lows, closes, 20));
  const atr = last(atrSeries(highs, lows, closes, 14));
  const bollinger = last(bollingerSeries(closes, 20, 2));
  const obvRows = obvSeries(closes, volumes);
  const volumeRatio = ratioToAverage(volumes.at(-1) ?? 0, volumes.slice(-21, -1));
  const obvSlope = slope(obvRows.slice(-10));
  const oneBarReturn = percentChange(closes.at(-2), price);
  const twentyBarHigh = Math.max(...highs.slice(-21, -1));
  const twentyBarLow = Math.min(...lows.slice(-21, -1));

  const components: Record<string, number> = {};
  const add = (key: string, value: number) => {
    components[key] = value;
  };

  add("trend", trendScore(price, ema50, ema200, ema50Series, ema200Series));
  add("macd", macdScore(macdPrev, macdNow));
  add("rsi", rsiScore(rsi));
  add("stochastic", stochasticScore(stochasticPrev, stochastic));
  add("cci", cciScore(cci));
  add("bollinger", bollingerScore(bollinger?.position ?? null, rsi));
  add("volume", volumeScore(volumeRatio, price, twentyBarHigh, twentyBarLow, oneBarReturn));
  add("obv", obvScore(obvSlope));
  add("news", clamp(news.score, -18, 18));

  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  const direction: Direction = score >= BUY_THRESHOLD ? "buy" : score <= SELL_THRESHOLD ? "sell" : "neutral";

  return {
    symbol: coin.binanceSymbol,
    asset: coin.symbol,
    coinId: coin.id,
    coinName: coin.name,
    marketCapRank: coin.marketCapRank,
    timeframe,
    direction,
    score: round(score),
    reason: explainSignal(direction, components, news),
    price,
    rsi,
    macd: macdNow?.macd ?? null,
    macdSignal: macdNow?.signal ?? null,
    macdHistogram: macdNow?.histogram ?? null,
    ema50,
    ema200,
    stochasticK: stochastic?.k ?? null,
    stochasticD: stochastic?.d ?? null,
    cci,
    atrPercent: atr && price ? (atr / price) * 100 : null,
    bollingerPosition: bollinger?.position ?? null,
    volumeRatio,
    obvSlope,
    newsScore: news.score,
    newsArticleCount: news.articleCount,
    components,
  };
}

async function notifyOnDirectionChange(signal: Signal) {
  const db = getFirestore();
  const stateRef = db.collection("state").doc(`${signal.symbol}_${signal.timeframe}`);
  const state = await stateRef.get();
  const lastDirection = state.exists ? state.data()?.lastDirection : undefined;
  const lastScore = state.exists ? Number(state.data()?.lastScore ?? 0) : 0;

  if (lastDirection === signal.direction && Math.abs(signal.score - lastScore) < 15) {
    logger.info("Signal already notified", { symbol: signal.symbol, timeframe: signal.timeframe });
    return;
  }

  await sendKakaoMemo(signal);
  await stateRef.set({
    lastDirection: signal.direction,
    lastScore: signal.score,
    lastReason: signal.reason,
    lastPrice: signal.price,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function sendKakaoMemo(signal: Signal) {
  const accessToken = await refreshKakaoAccessToken();
  const label = signal.direction === "buy" ? "매수 관심" : "매도 경계";
  const message = `[${label}] ${signal.symbol} ${signal.timeframe}
점수: ${signal.score}
가격: ${signal.price.toLocaleString("ko-KR", { maximumFractionDigits: 6 })} USDT
시총 순위: #${signal.marketCapRank}
${signal.reason}`;

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
        link: {
          web_url: siteUrl.value(),
          mobile_web_url: siteUrl.value(),
        },
      }),
    }),
  });

  if (!response.ok) {
    throw new Error(`Kakao memo send failed: ${response.status} ${await response.text()}`);
  }
}

async function refreshKakaoAccessToken() {
  const response = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: kakaoRestApiKey.value(),
      refresh_token: kakaoRefreshToken.value(),
    }),
  });

  if (!response.ok) {
    throw new Error(`Kakao token refresh failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

function trendScore(
  price: number,
  ema50: number | null,
  ema200: number | null,
  ema50Series: Array<number | null>,
  ema200Series: Array<number | null>,
) {
  if (ema50 === null || ema200 === null) return 0;
  const previousEma50 = ema50Series.at(-2) ?? null;
  const previousEma200 = ema200Series.at(-2) ?? null;
  let score = 0;

  if (price > ema50 && ema50 > ema200) score += 18;
  if (price < ema50 && ema50 < ema200) score -= 18;
  if (previousEma50 !== null && previousEma200 !== null && previousEma50 <= previousEma200 && ema50 > ema200) score += 18;
  if (previousEma50 !== null && previousEma200 !== null && previousEma50 >= previousEma200 && ema50 < ema200) score -= 18;

  return score;
}

function macdScore(
  previous: { macd: number; signal: number; histogram: number } | undefined,
  current: { macd: number; signal: number; histogram: number } | undefined,
) {
  if (!previous || !current) return 0;
  if (previous.histogram <= 0 && current.histogram > 0) return 16;
  if (previous.histogram >= 0 && current.histogram < 0) return -16;
  if (current.histogram > previous.histogram && current.histogram > 0) return 7;
  if (current.histogram < previous.histogram && current.histogram < 0) return -7;
  return 0;
}

function rsiScore(rsi: number | null) {
  if (rsi === null) return 0;
  if (rsi <= 25) return 15;
  if (rsi <= 32) return 10;
  if (rsi >= 75) return -15;
  if (rsi >= 68) return -10;
  if (rsi > 50 && rsi < 64) return 5;
  if (rsi < 50 && rsi > 36) return -5;
  return 0;
}

function stochasticScore(
  previous: { k: number; d: number } | undefined,
  current: { k: number; d: number } | undefined,
) {
  if (!previous || !current) return 0;
  if (previous.k <= previous.d && current.k > current.d && current.k < 30) return 10;
  if (previous.k >= previous.d && current.k < current.d && current.k > 70) return -10;
  return 0;
}

function cciScore(cci: number | null) {
  if (cci === null) return 0;
  if (cci <= -150) return 8;
  if (cci >= 150) return -8;
  if (cci > 100) return 5;
  if (cci < -100) return -5;
  return 0;
}

function bollingerScore(position: number | null, rsi: number | null) {
  if (position === null) return 0;
  if (position <= 0.05 && rsi !== null && rsi < 38) return 10;
  if (position >= 0.95 && rsi !== null && rsi > 62) return -10;
  if (position > 1) return 6;
  if (position < 0) return -6;
  return 0;
}

function volumeScore(
  volumeRatio: number | null,
  price: number,
  twentyBarHigh: number,
  twentyBarLow: number,
  oneBarReturn: number | null,
) {
  if (volumeRatio === null || oneBarReturn === null || volumeRatio < 1.8) return 0;
  if (price >= twentyBarHigh && oneBarReturn > 0) return 12;
  if (price <= twentyBarLow && oneBarReturn < 0) return -12;
  return oneBarReturn > 0 ? 5 : -5;
}

function obvScore(obvSlope: number | null) {
  if (obvSlope === null) return 0;
  if (obvSlope > 0) return 7;
  if (obvSlope < 0) return -7;
  return 0;
}

function explainSignal(direction: Direction, components: Record<string, number>, news: NewsScore) {
  const sorted = Object.entries(components)
    .filter(([, value]) => value !== 0)
    .sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))
    .slice(0, 4)
    .map(([key, value]) => `${key} ${value > 0 ? "+" : ""}${value}`);
  const base = sorted.length ? sorted.join(", ") : "뚜렷한 우위 없음";
  const newsText = news.articleCount ? `뉴스 ${news.score > 0 ? "+" : ""}${round(news.score)} (${news.articleCount}건)` : "뉴스 없음";

  if (direction === "buy") return `매수 점수 우위: ${base}; ${newsText}`;
  if (direction === "sell") return `매도 점수 우위: ${base}; ${newsText}`;
  return `중립: ${base}; ${newsText}`;
}

function scoreNewsTitles(titles: string[]): NewsScore {
  const positive = [
    "approval",
    "approved",
    "partnership",
    "upgrade",
    "launch",
    "record",
    "surge",
    "rally",
    "bull",
    "inflow",
    "adoption",
    "profit",
  ];
  const negative = [
    "hack",
    "lawsuit",
    "probe",
    "exploit",
    "outflow",
    "ban",
    "fraud",
    "crash",
    "selloff",
    "bear",
    "liquidation",
    "loss",
  ];
  let positiveCount = 0;
  let negativeCount = 0;

  for (const title of titles) {
    const normalized = title.toLowerCase();
    if (positive.some((word) => normalized.includes(word))) positiveCount += 1;
    if (negative.some((word) => normalized.includes(word))) negativeCount += 1;
  }

  return {
    score: clamp((positiveCount - negativeCount) * 4, -18, 18),
    articleCount: titles.length,
    positiveCount,
    negativeCount,
    sampleTitles: titles.slice(0, 3),
  };
}

function emptyNewsScore(): NewsScore {
  return {
    score: 0,
    articleCount: 0,
    positiveCount: 0,
    negativeCount: 0,
    sampleTitles: [],
  };
}

function rsiSeries(values: number[], period: number): Array<number | null> {
  if (values.length <= period) return [];

  const result: Array<number | null> = Array(period).fill(null);
  let gain = 0;
  let loss = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }

  let averageGain = gain / period;
  let averageLoss = loss / period;
  result.push(toRsi(averageGain, averageLoss));

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result.push(toRsi(averageGain, averageLoss));
  }

  return result;
}

function toRsi(averageGain: number, averageLoss: number) {
  if (averageLoss === 0) return 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function macdSeries(values: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number) {
  const fast = emaSeries(values, fastPeriod);
  const slow = emaSeries(values, slowPeriod);
  const macd = values.map((_, index) =>
    fast[index] === null || slow[index] === null ? null : Number(fast[index]) - Number(slow[index]),
  );
  const signal = emaSeries(macd, signalPeriod);

  return macd.map((value, index) => ({
    macd: value ?? 0,
    signal: signal[index] ?? 0,
    histogram: value !== null && signal[index] !== null ? value - Number(signal[index]) : 0,
  }));
}

function emaSeries(values: Array<number | null>, period: number): Array<number | null> {
  const multiplier = 2 / (period + 1);
  const result: Array<number | null> = [];
  let ema: number | null = null;
  const seed: number[] = [];

  for (const value of values) {
    if (value === null) {
      result.push(null);
      continue;
    }

    if (ema === null) {
      seed.push(value);
      if (seed.length < period) {
        result.push(null);
        continue;
      }
      ema = average(seed);
      result.push(ema);
      continue;
    }

    ema = (value - ema) * multiplier + ema;
    result.push(ema);
  }

  return result;
}

function stochasticSeries(highs: number[], lows: number[], closes: number[], period: number, signalPeriod: number) {
  const kValues = closes.map((close, index) => {
    if (index + 1 < period) return null;
    const high = Math.max(...highs.slice(index + 1 - period, index + 1));
    const low = Math.min(...lows.slice(index + 1 - period, index + 1));
    return high === low ? 50 : ((close - low) / (high - low)) * 100;
  });
  const dValues = smaSeries(kValues, signalPeriod);

  return kValues.map((k, index) => ({
    k: k ?? 0,
    d: dValues[index] ?? 0,
  }));
}

function cciSeries(highs: number[], lows: number[], closes: number[], period: number): Array<number | null> {
  const typical = closes.map((close, index) => (highs[index] + lows[index] + close) / 3);

  return typical.map((value, index) => {
    if (index + 1 < period) return null;
    const window = typical.slice(index + 1 - period, index + 1);
    const mean = average(window);
    const meanDeviation = average(window.map((item) => Math.abs(item - mean)));
    return meanDeviation === 0 ? 0 : (value - mean) / (0.015 * meanDeviation);
  });
}

function atrSeries(highs: number[], lows: number[], closes: number[], period: number): Array<number | null> {
  const ranges = highs.map((high, index) => {
    if (index === 0) return high - lows[index];
    return Math.max(high - lows[index], Math.abs(high - closes[index - 1]), Math.abs(lows[index] - closes[index - 1]));
  });
  return emaSeries(ranges, period);
}

function bollingerSeries(values: number[], period: number, deviation: number): Array<{ position: number } | null> {
  return values.map((value, index) => {
    if (index + 1 < period) return null;
    const window = values.slice(index + 1 - period, index + 1);
    const middle = average(window);
    const variance = average(window.map((item) => (item - middle) ** 2));
    const width = Math.sqrt(variance) * deviation * 2;
    const lower = middle - width / 2;
    return width === 0 ? { position: 0.5 } : { position: (value - lower) / width };
  });
}

function obvSeries(closes: number[], volumes: number[]) {
  const values = [0];
  for (let index = 1; index < closes.length; index += 1) {
    const previous = values[index - 1];
    if (closes[index] > closes[index - 1]) values.push(previous + volumes[index]);
    else if (closes[index] < closes[index - 1]) values.push(previous - volumes[index]);
    else values.push(previous);
  }
  return values;
}

function smaSeries(values: Array<number | null>, period: number): Array<number | null> {
  return values.map((_, index) => {
    const window = values.slice(Math.max(0, index + 1 - period), index + 1).filter((value) => value !== null);
    if (window.length < period) return null;
    return average(window);
  });
}

function ratioToAverage(value: number, values: number[]) {
  const avg = average(values);
  return avg > 0 ? value / avg : null;
}

function percentChange(previous: number | undefined, current: number | undefined) {
  if (!previous || current === undefined) return null;
  return ((current - previous) / previous) * 100;
}

function slope(values: number[]) {
  if (values.length < 2) return null;
  return values[values.length - 1] - values[0];
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function last<T>(values: T[]) {
  return values.length ? values[values.length - 1] : null;
}

function round(value: number | null) {
  if (value === null) return 0;
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
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
