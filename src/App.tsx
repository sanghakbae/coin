import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Code2, Coins, ExternalLink, Landmark, Network, Newspaper, RefreshCw, ShieldCheck, TrendingUp } from "lucide-react";
import xxhash from "xxhash-wasm";
import assetsJson from "./assets.json";
import { evaluateDotSignal } from "./signal-model.mjs";

type AssetRepo = {
  owner: string;
  repo: string;
  label: string;
  role: string;
  branch: string;
};
type AssetConfig = {
  coinId: string;
  label: string;
  symbol: string;
  binanceSymbol: string;
  btcSymbol: string;
  newsKeywords: string[];
  newsPattern: RegExp;
  networkAdapter: "polkadot" | "xrpl" | "avalanche" | "none";
  officialNewsUrl: string;
  ecosystemCategory: string | null;
  ecosystemTitle: string;
  repos: AssetRepo[];
};
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const ASSETS = Object.fromEntries(
  Object.entries(assetsJson).map(([key, asset]) => [
    key,
    {
      ...asset,
      newsPattern: new RegExp(asset.newsKeywords.map(escapeRegExp).join("|"), "i"),
    },
  ]),
) as Record<keyof typeof assetsJson, AssetConfig>;
const CHART_RANGES = [
  { label: "1주", value: "7d", days: 7 },
  { label: "1개월", value: "1m", days: 30 },
  { label: "3개월", value: "3m", days: 90 },
  { label: "6개월", value: "6m", days: 180 },
  { label: "1년", value: "1y", days: 365 },
] as const;
const BINANCE_BASES = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];
const POLKADOT_RELAY_RPC_ENDPOINTS = ["https://rpc.polkadot.io", "https://polkadot-rpc.publicnode.com"];
const POLKADOT_ASSET_HUB_RPC_ENDPOINTS = ["https://polkadot-asset-hub-rpc.polkadot.io", "https://asset-hub.polkadot.rpc.deserve.network"];
const rpcPreferredEndpoint = new Map<string, number>();
const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "USDS", "DAI", "FDUSD", "TUSD", "USDE", "USDD", "USDP", "PYUSD", "USD1", "GUSD", "FRAX", "LUSD", "SUSD", "BUSD",
  "RLUSD", "USD0", "USDY", "USYC", "USUALUSD", "USDTB", "SUSDS", "SUSDE", "EURC", "EURS", "EURT", "EURI", "AEUR", "EURCV",
]);

type ChartRange = (typeof CHART_RANGES)[number]["value"];
type SignalDirection = "buy" | "risk" | "neutral";
type AssetKey = keyof typeof assetsJson;

interface Candle {
  openTime: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

interface DotSignal {
  direction: SignalDirection;
  label: string;
  score: number;
  developmentIndex: number;
  confidence: number;
  riskLevel: "low" | "medium" | "high" | "unknown";
  components: Record<string, number>;
  reasons: string[];
}

interface NewsItem {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: number;
  sentiment: number;
}

interface DevItem {
  id: string;
  repo: string;
  title: string;
  url: string;
  date: string;
  type: "commit" | "release";
}

interface DotMarketInfo {
  rank: number | null;
  marketCap: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
}

interface FxRate {
  rate: number;
  date: string;
}

interface NetworkInfo {
  peers: number;
  syncing: boolean;
  bestBlock: number;
  finalizedBlock: number;
  runtimeVersion: number;
}

interface MacroInfo {
  btcPrice: number;
  btcEma200: number | null;
  btcChange24h: number;
  assetBtcChange7d: number | null;
}

interface XrplInfo {
  ledgerIndex: number;
  ledgerAge: number;
  baseFeeXrp: number;
  loadFactor: number;
  peers: number;
  serverState: string;
  buildVersion: string;
  networkHealthy: boolean;
}

interface AvalancheInfo {
  blockNumber: number;
  networkId: number;
  nodeVersion: string;
  networkHealthy: boolean;
}

interface DerivativesInfo {
  fundingRatePercent: number;
  openInterestDot: number;
  openInterestUsd: number;
  openInterestChange24h: number | null;
  longShortRatio: number;
}

interface OnchainInfo {
  totalIssuance: number;
  totalStaked: number;
  stakedPercent: number;
  activeValidators: number;
  nominatorCount: number;
  referendumCount: number;
  recentOngoingReferenda: number;
  averageExtrinsics: number;
  cached?: boolean;
  updatedAt?: string;
}

interface EtfInfo {
  aum: number;
  nav: number;
  marketPrice: number;
  sharesOutstanding: number;
  dotHoldings: number;
  dayChange: number;
  monthChange: number;
  premiumDiscount: number;
  dailyVolume: number;
  average30dVolume: number;
  volumeRatio: number | null;
  sharesChange5d: number | null;
  aumChange5d: number | null;
  valuationDate: string;
}

interface EcosystemProject {
  id: string;
  name: string;
  symbol: string;
  image: string;
  price: number | null;
  marketCap: number | null;
  change24h: number | null;
}

interface NewEcosystemProject extends EcosystemProject {
  firstSeen: number;
}

function formatNumber(value: number | null, digits = 2) {
  if (value === null || Number.isNaN(value)) return "-";
  return value.toLocaleString("ko-KR", { maximumFractionDigits: digits });
}

function formatUsdt(value: number | null) {
  if (value === null || Number.isNaN(value)) return "-";
  const abs = Math.abs(value);
  const maximumFractionDigits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return value.toLocaleString("ko-KR", { maximumFractionDigits });
}

function formatPercent(value: number | null) {
  if (value === null || Number.isNaN(value)) return "-";
  return `${value >= 0 ? "+" : ""}${formatNumber(value)}%`;
}

function formatUsdCompact(value: number | null) {
  if (value === null || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("ko-KR", { currency: "USD", maximumFractionDigits: 1, notation: "compact", style: "currency" }).format(value);
}

function formatKrw(value: number | null) {
  if (value === null || Number.isNaN(value)) return "-";
  return new Intl.NumberFormat("ko-KR", { currency: "KRW", maximumFractionDigits: 0, style: "currency" }).format(value);
}

function formatUsdPrice(value: number | null) {
  if (value === null || Number.isNaN(value)) return "-";
  return `$${formatUsdt(value)}`;
}

function formatAssetAmount(value: number | null | undefined, symbol: string, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${formatNumber(value, digits)} ${symbol}`;
}

function isStableCoin(coin: { symbol: string; name: string }) {
  const symbol = coin.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return STABLE_SYMBOLS.has(symbol) || /stablecoin|\busd\b|dollar|\beuro\b/i.test(coin.name);
}

function formatDate(value: number | string) {
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(new Date(value));
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateSma(values: number[], period: number) {
  if (values.length < period) return null;
  return average(values.slice(-period));
}

function calculateEma(values: number[], period: number) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = average(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    ema = (values[index] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateRsi(closes: number[], period = 14) {
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

function calculateMacd(closes: number[]) {
  if (closes.length < 35) return { macd: null, signal: null, histogram: null };
  const macdSeries: number[] = [];
  for (let end = 26; end <= closes.length; end += 1) {
    const slice = closes.slice(0, end);
    const ema12 = calculateEma(slice, 12);
    const ema26 = calculateEma(slice, 26);
    if (ema12 !== null && ema26 !== null) macdSeries.push(ema12 - ema26);
  }
  const macd = macdSeries[macdSeries.length - 1] ?? null;
  const signal = calculateEma(macdSeries, 9);
  return { macd, signal, histogram: macd !== null && signal !== null ? macd - signal : null };
}

function calculateAtr(candles: Candle[], period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  let atr = average(ranges.slice(0, period));
  for (let index = period; index < ranges.length; index += 1) atr = (atr * (period - 1) + ranges[index]) / period;
  return atr;
}

function calculateAdx(candles: Candle[], period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const trueRanges: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    trueRanges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const dxValues: number[] = [];
  for (let end = period; end <= trueRanges.length; end += 1) {
    const atr = average(trueRanges.slice(end - period, end));
    if (!atr) continue;
    const plusDi = (average(plusDm.slice(end - period, end)) / atr) * 100;
    const minusDi = (average(minusDm.slice(end - period, end)) / atr) * 100;
    const total = plusDi + minusDi;
    if (total) dxValues.push((Math.abs(plusDi - minusDi) / total) * 100);
  }
  return dxValues.length >= period ? average(dxValues.slice(-period)) : null;
}

function calculateBollinger(closes: number[], period = 20, multiplier = 2) {
  if (closes.length < period) return { lower: null, middle: null, position: null, upper: null, widthPercent: null };
  const values = closes.slice(-period);
  const middle = average(values);
  const deviation = Math.sqrt(average(values.map((value) => (value - middle) ** 2)));
  const upper = middle + deviation * multiplier;
  const lower = middle - deviation * multiplier;
  const current = closes[closes.length - 1];
  return {
    lower,
    middle,
    position: upper === lower ? 0.5 : (current - lower) / (upper - lower),
    upper,
    widthPercent: middle ? ((upper - lower) / middle) * 100 : null,
  };
}

function calculatePeriodChange(closes: number[], days: number) {
  if (closes.length <= days) return null;
  const current = closes[closes.length - 1];
  const previous = closes[closes.length - 1 - days];
  return previous ? ((current - previous) / previous) * 100 : null;
}

function scoreNewsText(text: string) {
  const positive = ["adoption", "approve", "approved", "breakthrough", "growth", "launch", "milestone", "partnership", "release", "upgrade"];
  const negative = ["attack", "delay", "exploit", "hack", "lawsuit", "outage", "reject", "risk", "scam", "vulnerability"];
  const normalized = text.toLowerCase();
  const positiveHits = positive.filter((word) => normalized.includes(word)).length;
  const negativeHits = negative.filter((word) => normalized.includes(word)).length;
  return Math.max(-3, Math.min(3, positiveHits - negativeHits));
}

function rangeDays(range: ChartRange) {
  return CHART_RANGES.find((item) => item.value === range)?.days ?? 365;
}

function sliceByRange<T>(values: T[] | undefined, range: ChartRange) {
  return values?.slice(-rangeDays(range)) ?? [];
}

function chartPath(values: number[], width: number, height: number, padding = 14) {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;

  return values
    .map((value, index) => {
      const x = padding + (index / (values.length - 1)) * usableWidth;
      const y = padding + (1 - (value - min) / range) * usableHeight;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function monthMarkers(times: number[], width: number, padding: number) {
  if (times.length < 2) return [];
  const usableWidth = width - padding * 2;
  return times
    .map((time, index) => {
      const date = new Date(time);
      const previous = index > 0 ? new Date(times[index - 1]) : null;
      if (index === 0 || !previous || date.getMonth() === previous.getMonth()) return null;
      return { x: padding + (index / (times.length - 1)) * usableWidth, label: `${date.getMonth() + 1}월` };
    })
    .filter((marker): marker is { x: number; label: string } => marker !== null);
}

function weekMarkers(times: number[], width: number, padding: number) {
  if (times.length < 2) return [];
  const usableWidth = width - padding * 2;
  return times
    .map((time, index) => {
      const date = new Date(time);
      if (index === 0 || date.getUTCDay() !== 1) return null;
      return padding + (index / (times.length - 1)) * usableWidth;
    })
    .filter((x): x is number => x !== null);
}

function calculateDevelopmentIndex(devItems: DevItem[], repoCount: number) {
  const now = Date.now();
  const commits = devItems.filter((item) => item.type === "commit");
  const releases = devItems.filter((item) => item.type === "release");
  const commits30d = commits.filter((item) => now - new Date(item.date).getTime() <= 30 * 86_400_000);
  const activeRepos = new Set(commits30d.map((item) => item.repo)).size;
  const latestCommitAt = commits.reduce((latest, item) => Math.max(latest, new Date(item.date).getTime()), 0);
  const latestCommitDays = latestCommitAt ? (now - latestCommitAt) / 86_400_000 : Number.POSITIVE_INFINITY;
  const recencyScore = latestCommitDays <= 2 ? 40 : latestCommitDays <= 7 ? 34 : latestCommitDays <= 14 ? 26 : latestCommitDays <= 30 ? 16 : latestCommitDays <= 60 ? 8 : 0;
  const breadthScore = Math.min(25, (activeRepos / repoCount) * 25);
  const cadenceScore = Math.min(20, (commits30d.length / (repoCount * 4)) * 20);
  const latestReleaseAt = releases.reduce((latest, item) => Math.max(latest, new Date(item.date).getTime()), 0);
  const latestReleaseDays = latestReleaseAt ? (now - latestReleaseAt) / 86_400_000 : Number.POSITIVE_INFINITY;
  const releaseScore = latestReleaseDays <= 90 ? 15 : latestReleaseDays <= 180 ? 8 : 0;
  return Math.round(Math.min(100, recencyScore + breadthScore + cadenceScore + releaseScore));
}

function developmentLabel(index: number) {
  if (index < 0) return "개발 데이터 확인 중";
  if (index >= 70) return "개발 매우 활발";
  if (index >= 40) return "개발 정상 진행";
  if (index >= 20) return "개발 활동 둔화";
  return "개발 장기 정체";
}

function developmentTone(index: number) {
  if (index < 0) return undefined;
  if (index >= 70) return "upText";
  if (index >= 40) return "watchText";
  return "downText";
}

function friendlyDataError(message: string) {
  if (/429|rate|too many/i.test(message)) return "요청 제한으로 잠시 대기 중";
  if (/failed to fetch|load failed|network/i.test(message)) return "네트워크 제한으로 잠시 대기 중";
  return "데이터 제공처 응답 대기 중";
}

function buildSignal(
  asset: AssetConfig,
  candles: Candle[],
  currentPrice: number | null,
  change24h: number | null,
  change7d: number | null,
  news: NewsItem[],
  devItems: DevItem[],
  networkHealthy: boolean | null,
  macroInfo: MacroInfo | null,
  derivativesInfo: DerivativesInfo | null,
  onchainInfo: OnchainInfo | null,
  etfInfo: EtfInfo | null,
  storedDevelopmentIndex: number | null,
): DotSignal {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const candlePrice = closes[closes.length - 1] ?? 0;
  const price = currentPrice ?? candlePrice;
  const previous = closes[closes.length - 2] ?? price;
  const rsi = calculateRsi(closes);
  const ema50 = calculateEma(closes, 50);
  const ema200 = calculateEma(closes, 200);
  const sma20w = calculateSma(closes, 140);
  const { histogram } = calculateMacd(closes);
  const volumeRatio = average(volumes.slice(-21, -1)) ? (volumes[volumes.length - 1] ?? 0) / average(volumes.slice(-21, -1)) : null;
  const bollinger = calculateBollinger(closes);
  const atr = calculateAtr(candles);
  const adx = calculateAdx(candles);
  const developmentIndex = devItems.length ? calculateDevelopmentIndex(devItems, asset.repos.length) : storedDevelopmentIndex ?? -1;
  const trendState: -1 | 0 | 1 = ema50 !== null && ema200 !== null && price > ema50 && ema50 > ema200 ? 1 : ema50 !== null && ema200 !== null && price < ema50 && ema50 < ema200 ? -1 : 0;
  const btcRegime: -1 | 0 | 1 = macroInfo?.btcEma200 ? (macroInfo.btcPrice >= macroInfo.btcEma200 ? 1 : -1) : 0;
  const result = evaluateDotSignal({
    assetSymbol: asset.symbol,
    above20w: sma20w === null ? null : price >= sma20w,
    activeValidators: onchainInfo?.activeValidators ?? null,
    adx,
    atrPercent: atr && price ? (atr / price) * 100 : null,
    bollingerPosition: bollinger.position,
    btcRegime,
    change24h,
    change7d,
    developmentIndex,
    dotBtcChange7d: macroInfo?.assetBtcChange7d ?? null,
    etfDayChange: etfInfo?.dayChange ?? null,
    etfPremiumDiscount: etfInfo?.premiumDiscount ?? null,
    etfSharesChange5d: etfInfo?.sharesChange5d ?? null,
    etfVolumeRatio: etfInfo?.volumeRatio ?? null,
    fundingRatePercent: derivativesInfo?.fundingRatePercent ?? null,
    longShortRatio: derivativesInfo?.longShortRatio ?? null,
    macdHistogram: histogram,
    networkHealthy,
    newsBalance: news.reduce((sum, item) => sum + item.sentiment, 0),
    openInterestChange24h: derivativesInfo?.openInterestChange24h ?? null,
    priceUp: price >= previous,
    rsi,
    stakedPercent: onchainInfo?.stakedPercent ?? null,
    trendState,
    volumeRatio,
  });
  return {
    ...result,
    developmentIndex,
    label: result.direction === "buy" ? "매수" : result.direction === "risk" ? "매도" : "관망",
  };
}

async function fetchBinanceJson(path: string) {
  const errors: string[] = [];
  for (const base of BINANCE_BASES) {
    try {
      const response = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
      if (response.ok) return await readJsonResponse(response, base);
      errors.push(`${base} ${response.status}`);
    } catch (error) {
      errors.push(`${base} ${error instanceof Error ? error.message : "연결 실패"}`);
    }
  }
  throw new Error(`Binance 데이터 요청 실패: ${errors.join(", ")}`);
}

async function readJsonResponse<T = unknown>(response: Response, source: string): Promise<T> {
  const body = await response.text();
  if (!body.trim()) throw new Error(`${source} 빈 응답`);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${source} JSON 응답 오류`);
  }
}

async function fetchCandles(symbol: string) {
  const rows = (await fetchBinanceJson(`/api/v3/klines?symbol=${symbol}&interval=1d&limit=365`)) as Array<[number, string, string, string, string, string]>;
  return rows.map((row) => ({
    openTime: Number(row[0]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  }));
}

async function fetchTicker24h(symbol: string) {
  const row = (await fetchBinanceJson(`/api/v3/ticker/24hr?symbol=${symbol}`)) as { lastPrice: string; priceChangePercent: string; volume: string; quoteVolume: string };
  return {
    price: Number(row.lastPrice),
    changePercent: Number(row.priceChangePercent),
    volume: Number(row.volume),
    quoteVolume: Number(row.quoteVolume),
  };
}

async function fetchMacroInfo(assetBtcSymbol: string): Promise<MacroInfo> {
  const [btcRows, btcTicker, assetBtcRows] = await Promise.all([
    fetchBinanceJson("/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=365") as Promise<Array<[number, string, string, string, string]>>,
    fetchBinanceJson("/api/v3/ticker/24hr?symbol=BTCUSDT") as Promise<{ lastPrice: string; priceChangePercent: string }>,
    fetchBinanceJson(`/api/v3/klines?symbol=${assetBtcSymbol}&interval=1d&limit=30`) as Promise<Array<[number, string, string, string, string]>>,
  ]);
  const btcCloses = btcRows.map((row) => Number(row[4]));
  const assetBtcCloses = assetBtcRows.map((row) => Number(row[4]));
  return {
    btcChange24h: Number(btcTicker.priceChangePercent),
    btcEma200: calculateEma(btcCloses, 200),
    btcPrice: Number(btcTicker.lastPrice),
    assetBtcChange7d: calculatePeriodChange(assetBtcCloses, 7),
  };
}

async function fetchFuturesJson<T>(path: string): Promise<T> {
  const bases = ["https://fapi.binance.com", "https://fapi1.binance.com"];
  for (const base of bases) {
    try {
      const response = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
      if (response.ok) return await readJsonResponse<T>(response, base);
    } catch {
      // Try the next Binance futures endpoint.
    }
  }
  throw new Error("Binance 선물 데이터를 불러오지 못했습니다.");
}

async function fetchDerivativesInfo(symbol: string): Promise<DerivativesInfo> {
  const [premium, openInterest, history, ratios] = await Promise.all([
    fetchFuturesJson<{ lastFundingRate: string; markPrice: string }>(`/fapi/v1/premiumIndex?symbol=${symbol}`),
    fetchFuturesJson<{ openInterest: string }>(`/fapi/v1/openInterest?symbol=${symbol}`),
    fetchFuturesJson<Array<{ sumOpenInterest: string; sumOpenInterestValue: string }>>(`/futures/data/openInterestHist?symbol=${symbol}&period=1d&limit=2`),
    fetchFuturesJson<Array<{ longShortRatio: string }>>(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1d&limit=1`),
  ]);
  const currentHistory = history[history.length - 1];
  const previousHistory = history[0];
  const currentOpenInterest = Number(openInterest.openInterest);
  const previousOpenInterest = Number(previousHistory?.sumOpenInterest ?? 0);
  return {
    fundingRatePercent: Number(premium.lastFundingRate) * 100,
    longShortRatio: Number(ratios[ratios.length - 1]?.longShortRatio ?? 0),
    openInterestChange24h: previousOpenInterest ? ((Number(currentHistory?.sumOpenInterest ?? currentOpenInterest) - previousOpenInterest) / previousOpenInterest) * 100 : null,
    openInterestDot: currentOpenInterest,
    openInterestUsd: currentOpenInterest * Number(premium.markPrice),
  };
}

async function fetchEtfInfo(): Promise<EtfInfo> {
  const [detailsResponse, historyResponse] = await Promise.all([
    fetch("https://api.primary.21shares.com/api/product_details/TDOT", { headers: { accept: "application/json" } }),
    fetch("https://api.primary.21shares.com/api/product_valuation_history/TDOT", { headers: { accept: "application/json" } }),
  ]);
  if (!detailsResponse.ok || !historyResponse.ok) throw new Error("TDOT ETF 데이터를 불러오지 못했습니다.");
  const details = (await detailsResponse.json()) as {
    data: {
      total_nav: number;
      nav_per_unit: number;
      total_units_outstanding: number;
      valuation_date: string;
      daily_trading_volume: number;
      "30day_trading_volume": number;
      constituents: Array<{ quantity: number }>;
    };
  };
  const history = (await historyResponse.json()) as {
    data: Array<{
      total_nav: number;
      total_units_outstanding: number;
      nav_per_share: number;
      market_price: number;
      market_price_percentage_change: number;
      premium_discount: number;
      daily_trading_volume: number;
      trading_volume_30d: number;
      valuation_date: string;
    }>;
  };
  const latest = history.data[0];
  const comparison = history.data[Math.min(5, history.data.length - 1)];
  const average30dVolume = latest?.trading_volume_30d ?? details.data["30day_trading_volume"];
  return {
    aum: latest?.total_nav ?? details.data.total_nav,
    aumChange5d: comparison?.total_nav ? (((latest?.total_nav ?? details.data.total_nav) - comparison.total_nav) / comparison.total_nav) * 100 : null,
    average30dVolume,
    dailyVolume: latest?.daily_trading_volume ?? details.data.daily_trading_volume,
    dayChange: latest?.market_price_percentage_change ?? 0,
    dotHoldings: details.data.constituents[0]?.quantity ?? 0,
    marketPrice: latest?.market_price ?? details.data.nav_per_unit,
    monthChange: history.data.length > 20 && history.data[20].market_price ? ((latest.market_price - history.data[20].market_price) / history.data[20].market_price) * 100 : 0,
    nav: latest?.nav_per_share ?? details.data.nav_per_unit,
    premiumDiscount: latest?.premium_discount ?? 0,
    sharesChange5d: comparison?.total_units_outstanding ? (((latest?.total_units_outstanding ?? details.data.total_units_outstanding) - comparison.total_units_outstanding) / comparison.total_units_outstanding) * 100 : null,
    sharesOutstanding: latest?.total_units_outstanding ?? details.data.total_units_outstanding,
    valuationDate: latest?.valuation_date ?? details.data.valuation_date,
    volumeRatio: average30dVolume ? (latest?.daily_trading_volume ?? details.data.daily_trading_volume) / average30dVolume : null,
  };
}

async function fetchOnchainInfo(): Promise<OnchainInfo> {
  try {
    return await fetchLiveOnchainInfo();
  } catch (error) {
    const cached = await fetchStoredOnchainInfo().catch(() => null);
    if (cached) return cached;
    throw error;
  }
}

async function fetchLiveOnchainInfo(): Promise<OnchainInfo> {
  const keys = {
    activeEra: "0x5f3e4907f716ac89b6347d15ececedca487df464e44a534ba6b0cbb32407b587",
    issuance: "0xc2261276cc9d1f8598ea4b6a74b15c2f57c875e4cff74148e4628f264b974c80",
    nominators: "0x5f3e4907f716ac89b6347d15ececedcaf99b25852d3d69419882da651375cdb3",
    referendumCount: "0x0f6738a0ee80c8e74cd2c7417c1e25567f17cdfbfa73331856cca0acddd7842e",
    totalStakePrefix: "0x5f3e4907f716ac89b6347d15ececedcaa141c4fe67c2d11f4a10c6aca7a79a04",
    validatorCount: "0x5f3e4907f716ac89b6347d15ececedca138e71612491192d68deab7e6f563fe1",
  };
  const activeEraHex = await polkadotRpc<string | null>("state_getStorage", [keys.activeEra], POLKADOT_ASSET_HUB_RPC_ENDPOINTS);
  if (!activeEraHex || activeEraHex.length < 10) throw new Error("활성 era를 확인하지 못했습니다.");
  const activeEra = decodeLittleEndianHex(`0x${activeEraHex.slice(2, 10)}`);
  const totalStakeKey = await storageMapKeyU32(keys.totalStakePrefix, activeEra);
  const storageKeys = [keys.issuance, keys.validatorCount, keys.nominators, keys.referendumCount, totalStakeKey];
  const [storageRows, latestBlock] = await Promise.all([
    polkadotRpc<Array<{ changes: Array<[string, string | null]> }>>("state_queryStorageAt", [storageKeys], POLKADOT_ASSET_HUB_RPC_ENDPOINTS),
    polkadotRpc<{ block: { extrinsics: string[] } }>("chain_getBlock"),
  ]);
  const storage = new Map(storageRows[0]?.changes ?? []);
  const issuanceHex = storage.get(keys.issuance) ?? null;
  const validatorHex = storage.get(keys.validatorCount) ?? null;
  const nominatorHex = storage.get(keys.nominators) ?? null;
  const referendumCountHex = storage.get(keys.referendumCount) ?? null;
  const totalStakeHex = storage.get(totalStakeKey) ?? null;
  const totalIssuance = decodeLittleEndianHex(issuanceHex) / 10_000_000_000;
  const totalStaked = decodeLittleEndianHex(totalStakeHex) / 10_000_000_000;
  return {
    activeValidators: decodeLittleEndianHex(validatorHex),
    averageExtrinsics: latestBlock.block.extrinsics.length,
    nominatorCount: decodeLittleEndianHex(nominatorHex),
    recentOngoingReferenda: -1,
    referendumCount: decodeLittleEndianHex(referendumCountHex),
    stakedPercent: totalIssuance ? (totalStaked / totalIssuance) * 100 : 0,
    totalIssuance,
    totalStaked,
  };
}

async function fetchUsdKrw(): Promise<FxRate> {
  const sources = [
    {
      url: "https://open.er-api.com/v6/latest/USD",
      parse: (data: { rates?: { KRW?: number }; time_last_update_utc?: string }) => ({
        rate: data.rates?.KRW ?? 0,
        date: data.time_last_update_utc ?? new Date().toISOString(),
      }),
    },
    {
      url: "https://api.frankfurter.app/latest?from=USD&to=KRW",
      parse: (data: { rates?: { KRW?: number }; date?: string }) => ({
        rate: data.rates?.KRW ?? 0,
        date: data.date ?? new Date().toISOString(),
      }),
    },
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source.url, { headers: { accept: "application/json" } });
      if (!response.ok) continue;
      const parsed = source.parse(await response.json());
      if (parsed.rate > 0) return parsed;
    } catch {
      // Try the next public exchange-rate source.
    }
  }
  throw new Error("USD/KRW 환율을 불러오지 못했습니다.");
}

async function polkadotRpc<T>(method: string, params: unknown[] = [], endpoints: string | string[] = POLKADOT_RELAY_RPC_ENDPOINTS): Promise<T> {
  const candidates = Array.isArray(endpoints) ? endpoints : [endpoints];
  const poolKey = candidates.join("|");
  const preferred = rpcPreferredEndpoint.get(poolKey) ?? 0;
  const ordered = [...candidates.slice(preferred), ...candidates.slice(0, preferred)];
  const errors: string[] = [];

  for (const endpoint of ordered) {
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
        signal: controller.signal,
      });
      window.clearTimeout(timeout);
      if (!response.ok) {
        errors.push(`${new URL(endpoint).hostname} ${response.status}`);
        continue;
      }
      const data = (await response.json()) as { result?: T; error?: { message?: string } };
      if (data.error || data.result === undefined) {
        errors.push(`${new URL(endpoint).hostname} ${data.error?.message || "응답 오류"}`);
        continue;
      }
      rpcPreferredEndpoint.set(poolKey, candidates.indexOf(endpoint));
      return data.result;
    } catch (error) {
      errors.push(`${new URL(endpoint).hostname} ${error instanceof Error && error.name === "AbortError" ? "시간 초과" : "연결 실패"}`);
    }
  }
  throw new Error(`Polkadot RPC 요청 실패: ${errors.join(", ")}`);
}

function decodeLittleEndianHex(value: string | null) {
  if (!value) return 0;
  const bytes = value.slice(2).match(/.{2}/g) ?? [];
  return Number(BigInt(`0x${bytes.reverse().join("") || "0"}`));
}

async function storageMapKeyU32(prefix: string, value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  const { h64Raw } = await xxhash();
  const hash = h64Raw(bytes, 0n).toString(16).padStart(16, "0").match(/.{2}/g)?.reverse().join("") ?? "";
  const encoded = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hash}${encoded}`;
}

async function fetchNetworkInfo(): Promise<NetworkInfo> {
  const [health, bestHeader, finalizedHash, runtime] = await Promise.all([
    polkadotRpc<{ peers: number; isSyncing: boolean }>("system_health"),
    polkadotRpc<{ number: string }>("chain_getHeader"),
    polkadotRpc<string>("chain_getFinalizedHead"),
    polkadotRpc<{ specVersion: number }>("state_getRuntimeVersion"),
  ]);
  const finalizedHeader = await polkadotRpc<{ number: string }>("chain_getHeader", [finalizedHash]);
  return {
    peers: health.peers,
    syncing: health.isSyncing,
    bestBlock: Number.parseInt(bestHeader.number, 16),
    finalizedBlock: Number.parseInt(finalizedHeader.number, 16),
    runtimeVersion: runtime.specVersion,
  };
}

async function fetchXrplInfo(): Promise<XrplInfo> {
  const response = await fetch("https://xrplcluster.com/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "server_info", params: [{ api_version: 1 }] }),
  });
  const data = await readJsonResponse<{ result?: { info?: { build_version?: string; load_factor?: number; peers?: number; server_state?: string; validated_ledger?: { age?: number; base_fee_xrp?: number; seq?: number } } } }>(response, "XRPL");
  const info = data.result?.info;
  const ledger = info?.validated_ledger;
  if (!info || !ledger?.seq) throw new Error("XRPL 검증 원장을 확인하지 못했습니다.");
  return {
    ledgerIndex: ledger.seq,
    ledgerAge: ledger.age ?? 0,
    baseFeeXrp: ledger.base_fee_xrp ?? 0,
    loadFactor: info.load_factor ?? 1,
    peers: info.peers ?? 0,
    serverState: info.server_state ?? "unknown",
    buildVersion: info.build_version ?? "-",
    networkHealthy: info.server_state === "full" && (ledger.age ?? 99) <= 10,
  };
}

async function fetchAvalancheInfo(): Promise<AvalancheInfo> {
  const request = async <T,>(url: string, method: string): Promise<T> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method.startsWith("info.") ? {} : [] }),
    });
    const data = await readJsonResponse<{ result?: T; error?: { message?: string } }>(response, "Avalanche RPC");
    if (data.error || data.result === undefined) throw new Error(data.error?.message || "Avalanche RPC 응답 오류");
    return data.result;
  };
  const [version, network, blockHex] = await Promise.all([
    request<{ version: string }>("https://api.avax.network/ext/info", "info.getNodeVersion"),
    request<{ networkID: string }>("https://api.avax.network/ext/info", "info.getNetworkID"),
    request<string>("https://api.avax.network/ext/bc/C/rpc", "eth_blockNumber"),
  ]);
  const blockNumber = Number.parseInt(blockHex, 16);
  return {
    blockNumber,
    networkId: Number(network.networkID),
    nodeVersion: version.version,
    networkHealthy: Number.isFinite(blockNumber) && Number(network.networkID) === 1,
  };
}

async function fetchNews(asset: AssetConfig): Promise<NewsItem[]> {
  try {
    const response = await fetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("news failed");
    const data = (await response.json()) as {
      Data?: Array<{ body?: string; id: string; title: string; source_info?: { name?: string }; url: string; published_on: number }>;
    };
    const rows = data.Data ?? [];
    const filtered = rows.filter((item) => asset.newsPattern.test(`${item.title} ${item.body ?? ""}`));
    return filtered.slice(0, 8).map((item) => ({
        id: item.id,
        title: item.title,
        source: item.source_info?.name ?? "CryptoCompare",
        url: item.url,
        publishedAt: item.published_on * 1000,
        sentiment: scoreNewsText(`${item.title} ${item.body ?? ""}`),
      }));
  } catch {
    return [
      {
        id: `${asset.symbol.toLowerCase()}-official-news`,
        title: `${asset.label} 공식 채널에서 최신 소식 확인`,
        source: asset.label,
        url: asset.officialNewsUrl,
        publishedAt: Date.now(),
        sentiment: 0,
      },
    ];
  }
}

async function fetchMarketInfo(asset: AssetConfig): Promise<DotMarketInfo> {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", "250");
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");
  const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`CoinGecko ${asset.symbol} 데이터 요청 실패: ${response.status}`);
  const rows = (await response.json()) as Array<{
    id: string;
    symbol: string;
    name: string;
    market_cap: number | null;
    circulating_supply: number | null;
    total_supply: number | null;
  }>;
  const withoutStablecoins = rows.filter((coin) => !isStableCoin(coin));
  const assetIndex = withoutStablecoins.findIndex((coin) => coin.id === asset.coinId);
  const marketAsset = withoutStablecoins[assetIndex];
  if (!marketAsset || assetIndex < 0) throw new Error(`스테이블 코인 제외 순위에서 ${asset.symbol}를 찾지 못했습니다.`);

  return {
    rank: assetIndex + 1,
    marketCap: marketAsset.market_cap ?? null,
    circulatingSupply: marketAsset.circulating_supply ?? null,
    totalSupply: marketAsset.total_supply ?? null,
  };
}

async function fetchEcosystemProjects(asset: AssetConfig): Promise<EcosystemProject[]> {
  if (!asset.ecosystemCategory) return [];
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("category", asset.ecosystemCategory);
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", "50");
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");
  url.searchParams.set("price_change_percentage", "24h");
  const response = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${asset.label} 생태계 요청 실패: ${response.status}`);
  const rows = (await response.json()) as Array<{
    id: string;
    name: string;
    symbol: string;
    image: string;
    current_price: number | null;
    market_cap: number | null;
    price_change_percentage_24h: number | null;
  }>;
  return rows
    .filter((coin) => coin.id !== asset.coinId && !isStableCoin(coin))
    .slice(0, 20)
    .map((coin) => ({
      id: coin.id,
      name: coin.name,
      symbol: coin.symbol.toUpperCase(),
      image: coin.image,
      price: coin.current_price,
      marketCap: coin.market_cap,
      change24h: coin.price_change_percentage_24h,
    }));
}

async function fetchNewEcosystemProjects(asset: AssetConfig, currentProjects: EcosystemProject[]): Promise<NewEcosystemProject[]> {
  const [{ collection, getDocs }, { db }] = await Promise.all([import("firebase/firestore"), import("./firebase")]);
  if (db) {
    const cutoff = Date.now() - 90 * 86_400_000;
    const readSnapshot = async (segments: string[]) => {
      const collectionRef = segments.length === 1
        ? collection(db, segments[0])
        : collection(db, segments[0], segments[1], segments[2]);
      const snapshot = await getDocs(collectionRef);
      return snapshot.docs
        .map((document) => {
          const data = document.data() as {
            name?: string;
            symbol?: string;
            image?: string;
            price?: number | null;
            marketCap?: number | null;
            change24h?: number | null;
            firstSeen?: { toMillis?: () => number };
            isBaseline?: boolean;
          };
          return {
            id: document.id,
            name: data.name ?? document.id,
            symbol: data.symbol ?? "-",
            image: data.image ?? "",
            price: data.price ?? null,
            marketCap: data.marketCap ?? null,
            change24h: data.change24h ?? null,
            firstSeen: data.firstSeen?.toMillis?.() ?? 0,
            isBaseline: data.isBaseline ?? true,
          };
        })
        .filter((project) => !project.isBaseline && project.firstSeen >= cutoff)
        .sort((left, right) => right.firstSeen - left.firstSeen)
        .slice(0, 6);
    };
    try {
      const projects = await readSnapshot(["ecosystemProjects", asset.symbol, "projects"]);
      if (projects.length) return projects;
    } catch {
      // Fall back to local snapshot until Firestore rules include this coin path.
    }
    if (asset.symbol === "DOT") {
      try {
        const projects = await readSnapshot(["ecosystemProjects"]);
        if (projects.length) return projects;
      } catch {
        // Fall back to this browser's previous category snapshot until legacy rules are deployed.
      }
    }
  }

  const storageKey = `${asset.symbol.toLowerCase()}-ecosystem-known-projects-v1`;
  const saved = window.localStorage.getItem(storageKey);
  const currentIds = currentProjects.map((project) => project.id);
  if (!saved) {
    window.localStorage.setItem(storageKey, JSON.stringify(currentIds));
    return [];
  }
  const knownIds = new Set<string>(JSON.parse(saved) as string[]);
  const added = currentProjects.filter((project) => !knownIds.has(project.id));
  window.localStorage.setItem(storageKey, JSON.stringify([...new Set([...knownIds, ...currentIds])]));
  return added.map((project) => ({ ...project, firstSeen: Date.now() })).slice(0, 6);
}

function parseGitHubAtomCommits(repo: AssetConfig["repos"][number], xml: string): DevItem[] {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  return Array.from(document.querySelectorAll("entry")).slice(0, 8).map((entry) => {
    const id = entry.querySelector("id")?.textContent?.trim() || `${repo.owner}/${repo.repo}-${entry.querySelector("updated")?.textContent ?? Date.now()}`;
    const title = entry.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim() || "최근 커밋";
    const url = entry.querySelector("link[rel='alternate']")?.getAttribute("href") || `https://github.com/${repo.owner}/${repo.repo}/commits`;
    const date = entry.querySelector("updated")?.textContent?.trim() || new Date().toISOString();
    return {
      id,
      repo: repo.repo,
      title,
      url,
      date,
      type: "commit" as const,
    };
  });
}

async function fetchGitHubAtomCommits(repo: AssetConfig["repos"][number]): Promise<DevItem[]> {
  const branchCandidates = [...new Set([repo.branch, "main", "master", "develop"].filter(Boolean))] as string[];
  for (const branch of branchCandidates) {
    try {
      const response = await fetch(`https://github.com/${repo.owner}/${repo.repo}/commits/${branch}.atom`, {
        cache: "no-store",
        headers: { accept: "application/atom+xml, application/xml, text/xml" },
      });
      if (!response.ok) continue;
      const items = parseGitHubAtomCommits(repo, await response.text());
      if (items.length) return items;
    } catch {
      // Try the next likely branch name.
    }
  }
  return [];
}

async function fetchDevStatus(repos: AssetConfig["repos"]): Promise<DevItem[]> {
  const repoItems = await Promise.all(
    repos.map(async (repoInfo) => {
      const repoPath = `${repoInfo.owner}/${repoInfo.repo}`;
      try {
        const branchParam = repoInfo.branch ? `&sha=${encodeURIComponent(repoInfo.branch)}` : "";
        const [commitsResponse, releasesResponse] = await Promise.all([
          fetch(`https://api.github.com/repos/${repoPath}/commits?per_page=4${branchParam}`, { cache: "no-store", headers: { accept: "application/vnd.github+json" } }),
          fetch(`https://api.github.com/repos/${repoPath}/releases?per_page=1`, { cache: "no-store", headers: { accept: "application/vnd.github+json" } }),
        ]);
        const commits = commitsResponse.ok
          ? ((await commitsResponse.json()) as Array<{ sha: string; html_url: string; commit: { message: string; author?: { date?: string } } }>)
          : [];
        const releases = releasesResponse.ok
          ? ((await releasesResponse.json()) as Array<{ id: number; html_url: string; name?: string; tag_name: string; published_at?: string }>)
          : [];
        const atomCommits = commits.length ? [] : await fetchGitHubAtomCommits(repoInfo);

        return [
          ...releases.map((item) => ({
            id: `${repoPath}-release-${item.id}`,
            repo: repoInfo.repo,
            title: item.name || item.tag_name,
            url: item.html_url,
            date: item.published_at ?? new Date().toISOString(),
            type: "release" as const,
          })),
          ...commits.map((item) => ({
            id: `${repoPath}-${item.sha}`,
            repo: repoInfo.repo,
            title: item.commit.message.split("\n")[0],
            url: item.html_url,
            date: item.commit.author?.date ?? new Date().toISOString(),
            type: "commit" as const,
          })),
          ...atomCommits,
        ];
      } catch {
        return fetchGitHubAtomCommits(repoInfo);
      }
    }),
  );

  return repoItems
    .flat()
    .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime())
    .slice(0, 15);
}

async function fetchStoredDevelopmentIndex(binanceSymbol: string) {
  const [{ doc, getDoc }, { db }] = await Promise.all([import("firebase/firestore"), import("./firebase")]);
  if (!db) return null;
  const snapshot = await getDoc(doc(db, "signals", `${binanceSymbol}_1d`));
  const value = Number(snapshot.data()?.developmentIndex);
  return Number.isFinite(value) ? value : null;
}

async function fetchStoredOnchainInfo(): Promise<OnchainInfo | null> {
  const [{ doc, getDoc }, { db }] = await Promise.all([import("firebase/firestore"), import("./firebase")]);
  if (!db) return null;
  const snapshot = await getDoc(doc(db, "signals", "DOTUSDT_1d"));
  const data = snapshot.data();
  const onchain = data?.onchain as Partial<OnchainInfo> | undefined;
  const required = [
    onchain?.totalIssuance,
    onchain?.totalStaked,
    onchain?.stakedPercent,
    onchain?.activeValidators,
    onchain?.nominatorCount,
    onchain?.referendumCount,
    onchain?.averageExtrinsics,
  ];
  if (!onchain || required.some((value) => !Number.isFinite(value))) return null;
  return {
    totalIssuance: Number(onchain.totalIssuance),
    totalStaked: Number(onchain.totalStaked),
    stakedPercent: Number(onchain.stakedPercent),
    activeValidators: Number(onchain.activeValidators),
    nominatorCount: Number(onchain.nominatorCount),
    referendumCount: Number(onchain.referendumCount),
    recentOngoingReferenda: Number.isFinite(onchain.recentOngoingReferenda) ? Number(onchain.recentOngoingReferenda) : -1,
    averageExtrinsics: Number(onchain.averageExtrinsics),
    cached: true,
    updatedAt: data?.createdAt?.toDate?.().toISOString?.(),
  };
}

function DotChart({ asset, candles, range }: { asset: AssetConfig; candles: Candle[]; range: ChartRange }) {
  const width = 960;
  const height = 250;
  const padding = 18;
  const visibleCandles = sliceByRange(candles, range);
  const values = visibleCandles.map((candle) => candle.close);
  const times = visibleCandles.map((candle) => candle.openTime);
  const path = chartPath(values, width, height, padding);
  const markers = monthMarkers(times, width, padding);
  const weeklyMarkers = weekMarkers(times, width, padding);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const selectedCandle = selectedIndex !== null ? visibleCandles[selectedIndex] ?? null : null;
  const first = values[0] ?? null;
  const last = values[values.length - 1] ?? null;
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  const change = first && last ? ((last - first) / first) * 100 : null;
  const stroke = change !== null && change >= 0 ? "#36e7b8" : "#ff746b";
  const areaPath = path ? `${path} L ${width - padding} ${height - padding} L ${padding} ${height - padding} Z` : "";
  const currentY = last !== null && min !== null && max !== null ? padding + (1 - (last - min) / (max - min || 1)) * (height - padding * 2) : height / 2;
  const currentTop = Math.max(8, Math.min(88, (currentY / height) * 100));
  const selectedX = selectedIndex !== null && visibleCandles.length > 1 ? padding + (selectedIndex / (visibleCandles.length - 1)) * (width - padding * 2) : null;
  const selectedY = selectedCandle !== null && min !== null && max !== null ? padding + (1 - (selectedCandle.close - min) / (max - min || 1)) * (height - padding * 2) : null;

  return (
    <section className="panel chartPanel">
      <div className="chartHeader">
        <div>
          <span>{asset.symbol} 가격 추이</span>
          <strong>{last ? `${formatUsdt(last)} USDT` : "-"}</strong>
          <small>고가 {formatUsdt(max)} · 저가 {formatUsdt(min)}</small>
        </div>
        <b className={change !== null && change >= 0 ? "positive" : "negative"}>{formatPercent(change)}</b>
      </div>
      <div className="chartCanvas">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${asset.symbol} 가격 차트. 누르면 해당 날짜의 시세와 거래량을 확인할 수 있습니다.`}
          preserveAspectRatio="none"
          onPointerDown={(event) => {
            if (!visibleCandles.length) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
            setSelectedIndex(Math.round(ratio * (visibleCandles.length - 1)));
          }}
        >
          <defs>
            <linearGradient id="dotAreaGradient" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.3" />
              <stop offset="72%" stopColor={stroke} stopOpacity="0.05" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75, 1].map((ratio) => (
            <path className="chartGrid" d={`M 0 ${height * ratio} L ${width} ${height * ratio}`} key={ratio} />
          ))}
          {weeklyMarkers.map((x) => (
            <path className="chartWeekLine" d={`M ${x.toFixed(2)} 0 L ${x.toFixed(2)} ${height}`} key={`week-${x}`} />
          ))}
          {markers.map((marker) => (
            <path className="chartMonthLine" d={`M ${marker.x.toFixed(2)} 0 L ${marker.x.toFixed(2)} ${height}`} key={`${marker.label}-${marker.x}`} />
          ))}
          <path d={areaPath} fill="url(#dotAreaGradient)" />
          <path className="priceLine" d={path} fill="none" stroke={stroke} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
          {selectedX !== null && selectedY !== null && (
            <>
              <path className="chartSelectionLine" d={`M ${selectedX} 0 L ${selectedX} ${height}`} />
              <circle className="chartSelectionDot" cx={selectedX} cy={selectedY} fill={stroke} r="5" />
            </>
          )}
        </svg>
        <div className={`chartMonthAxis ${markers.length > 6 ? "dense" : ""}`} aria-hidden="true">
          {markers.map((marker) => (
            <span key={`${marker.label}-axis-${marker.x}`} style={{ left: `${(marker.x / width) * 100}%` }}>
              {marker.label}
            </span>
          ))}
        </div>
        {last !== null && (
          <span className="currentPriceTag" style={{ top: `${currentTop}%`, borderColor: stroke, color: stroke }}>
            {formatUsdt(last)}
          </span>
        )}
        {selectedCandle && selectedX !== null && (
          <div className={`chartTooltip ${selectedX / width > 0.72 ? "alignRight" : ""}`} style={{ left: `${(selectedX / width) * 100}%` }}>
            <b>{new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "short", day: "numeric" }).format(new Date(selectedCandle.openTime))}</b>
            <span>종가 <strong>{formatUsdt(selectedCandle.close)} USDT</strong></span>
            <span>거래량 <strong>{formatNumber(selectedCandle.volume, 0)} {asset.symbol}</strong></span>
          </div>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [assetKey, setAssetKey] = useState<AssetKey>("DOT");
  const asset = ASSETS[assetKey];
  const [candles, setCandles] = useState<Candle[]>([]);
  const [ticker, setTicker] = useState<{ price: number; changePercent: number; volume: number; quoteVolume: number } | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [devItems, setDevItems] = useState<DevItem[]>([]);
  const [storedDevelopmentIndex, setStoredDevelopmentIndex] = useState<number | null>(null);
  const [marketInfo, setMarketInfo] = useState<DotMarketInfo | null>(null);
  const [fxRate, setFxRate] = useState<FxRate | null>(null);
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [xrplInfo, setXrplInfo] = useState<XrplInfo | null>(null);
  const [avalancheInfo, setAvalancheInfo] = useState<AvalancheInfo | null>(null);
  const [macroInfo, setMacroInfo] = useState<MacroInfo | null>(null);
  const [derivativesInfo, setDerivativesInfo] = useState<DerivativesInfo | null>(null);
  const [onchainInfo, setOnchainInfo] = useState<OnchainInfo | null>(null);
  const [etfInfo, setEtfInfo] = useState<EtfInfo | null>(null);
  const [ecosystemProjects, setEcosystemProjects] = useState<EcosystemProject[]>([]);
  const [newEcosystemProjects, setNewEcosystemProjects] = useState<NewEcosystemProject[]>([]);
  const [range, setRange] = useState<ChartRange>("3m");
  const [loading, setLoading] = useState(true);
  const [assessmentReady, setAssessmentReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ecosystemError, setEcosystemError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const indicator = useMemo(() => {
    const closes = candles.map((candle) => candle.close);
    const volumes = candles.map((candle) => candle.volume);
    const price = ticker?.price ?? closes[closes.length - 1] ?? null;
    const sma20w = calculateSma(closes, 140);
    const ema50 = calculateEma(closes, 50);
    const ema200 = calculateEma(closes, 200);
    const rsi = calculateRsi(closes);
    const macd = calculateMacd(closes);
    const atr = calculateAtr(candles);
    const adx = calculateAdx(candles);
    const bollinger = calculateBollinger(closes);
    const volumeRatio = average(volumes.slice(-21, -1)) ? (volumes[volumes.length - 1] ?? 0) / average(volumes.slice(-21, -1)) : null;
    const change7d = calculatePeriodChange(closes, 7);
    const change30d = calculatePeriodChange(closes, 30);
    const yearlyHigh = candles.length ? Math.max(...candles.map((candle) => candle.high)) : null;
    const yearlyLow = candles.length ? Math.min(...candles.map((candle) => candle.low)) : null;
    const fibPosition = price !== null && yearlyHigh !== null && yearlyLow !== null && yearlyHigh > yearlyLow ? ((price - yearlyLow) / (yearlyHigh - yearlyLow)) * 100 : null;
    const networkHealthy = asset.networkAdapter === "polkadot"
      ? networkInfo ? !networkInfo.syncing && networkInfo.bestBlock - networkInfo.finalizedBlock < 100 : null
      : asset.networkAdapter === "xrpl"
        ? xrplInfo?.networkHealthy ?? null
        : asset.networkAdapter === "avalanche"
          ? avalancheInfo?.networkHealthy ?? null
          : null;
    const signal = buildSignal(asset, candles, ticker?.price ?? null, ticker?.changePercent ?? null, change7d, news, devItems, networkHealthy, macroInfo, derivativesInfo, onchainInfo, etfInfo, storedDevelopmentIndex);

    return { price, sma20w, ema50, ema200, rsi, macd, atr, adx, bollinger, volumeRatio, yearlyHigh, yearlyLow, fibPosition, change7d, change30d, signal };
  }, [asset, avalancheInfo, candles, derivativesInfo, devItems, etfInfo, macroInfo, networkInfo, news, onchainInfo, storedDevelopmentIndex, ticker, xrplInfo]);

  async function loadData() {
    setLoading(true);
    setAssessmentReady(false);
    setError(null);
    setEcosystemError(null);
    setCandles([]);
    setTicker(null);
    setNews([]);
    setDevItems([]);
    setStoredDevelopmentIndex(null);
    setMarketInfo(null);
    setNetworkInfo(null);
    setXrplInfo(null);
    setAvalancheInfo(null);
    setMacroInfo(null);
    setDerivativesInfo(null);
    setOnchainInfo(null);
    setEtfInfo(null);
    setEcosystemProjects([]);
    setNewEcosystemProjects([]);
    try {
      const [candlesResult, tickerResult, newsResult, devResult, marketResult, fxResult, networkResult, xrplResult, avalancheResult, ecosystemResult, macroResult, derivativesResult, onchainResult, etfResult, storedDevelopmentResult] = await Promise.allSettled([
        fetchCandles(asset.binanceSymbol),
        fetchTicker24h(asset.binanceSymbol),
        fetchNews(asset),
        fetchDevStatus(asset.repos),
        fetchMarketInfo(asset),
        fetchUsdKrw(),
        asset.networkAdapter === "polkadot" ? fetchNetworkInfo() : Promise.resolve(null),
        asset.networkAdapter === "xrpl" ? fetchXrplInfo() : Promise.resolve(null),
        asset.networkAdapter === "avalanche" ? fetchAvalancheInfo() : Promise.resolve(null),
        fetchEcosystemProjects(asset),
        fetchMacroInfo(asset.btcSymbol),
        fetchDerivativesInfo(asset.binanceSymbol),
        asset.networkAdapter === "polkadot" ? fetchOnchainInfo() : Promise.resolve(null),
        asset.networkAdapter === "polkadot" ? fetchEtfInfo() : Promise.resolve(null),
        fetchStoredDevelopmentIndex(asset.binanceSymbol),
      ] as const);

      if (candlesResult.status === "fulfilled") setCandles(candlesResult.value);
      if (tickerResult.status === "fulfilled") setTicker(tickerResult.value);
      if (newsResult.status === "fulfilled") setNews(newsResult.value);
      if (devResult.status === "fulfilled") setDevItems(devResult.value);
      if (marketResult.status === "fulfilled") setMarketInfo(marketResult.value);
      if (fxResult.status === "fulfilled") setFxRate(fxResult.value);
      if (networkResult.status === "fulfilled") setNetworkInfo(networkResult.value);
      if (xrplResult.status === "fulfilled") setXrplInfo(xrplResult.value);
      if (avalancheResult.status === "fulfilled") setAvalancheInfo(avalancheResult.value);
      if (macroResult.status === "fulfilled") setMacroInfo(macroResult.value);
      if (derivativesResult.status === "fulfilled") setDerivativesInfo(derivativesResult.value);
      if (onchainResult.status === "fulfilled") setOnchainInfo(onchainResult.value);
      if (etfResult.status === "fulfilled") setEtfInfo(etfResult.value);
      if (storedDevelopmentResult.status === "fulfilled") setStoredDevelopmentIndex(storedDevelopmentResult.value);
      if (ecosystemResult.status === "fulfilled") {
        setEcosystemProjects(ecosystemResult.value);
        setNewEcosystemProjects(await fetchNewEcosystemProjects(asset, ecosystemResult.value).catch(() => []));
      } else if (asset.ecosystemCategory) {
        setEcosystemError(ecosystemResult.reason instanceof Error ? ecosystemResult.reason.message : "생태계 데이터를 불러오지 못했습니다.");
      }

      const criticalFailures = [
        ["가격 차트", candlesResult],
        ["현재가", tickerResult],
        ["BTC 시장", macroResult],
        ["선물 수급", derivativesResult],
      ].flatMap(([name, result]) =>
        typeof result === "object" && result.status === "rejected"
          ? [`${name as string} (${result.reason instanceof Error ? result.reason.message : "응답 오류"})`]
          : [],
      );
      if (criticalFailures.length) setError(`핵심 데이터 갱신 실패: ${criticalFailures.join(", ")}`);
      const developmentReady =
        devResult.status === "fulfilled" ||
        (storedDevelopmentResult.status === "fulfilled" && storedDevelopmentResult.value !== null) ||
        asset.networkAdapter !== "polkadot";
      setAssessmentReady(
        candlesResult.status === "fulfilled" &&
          candlesResult.value.length >= 200 &&
          tickerResult.status === "fulfilled" &&
          developmentReady &&
          macroResult.status === "fulfilled" &&
          derivativesResult.status === "fulfilled",
      );
      if (candlesResult.status === "fulfilled" || tickerResult.status === "fulfilled") setUpdatedAt(new Date());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : `${asset.symbol} 데이터를 불러오지 못했습니다.`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
    const timer = window.setInterval(() => void loadData(), 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [assetKey]);

  return (
    <main className="dotShell">
      <header className="heroPanel">
        <div className="assetSwitch" role="tablist" aria-label="분석 코인">
          {(Object.entries(ASSETS) as Array<[AssetKey, AssetConfig]>).map(([key, item]) => (
            <button
              aria-selected={assetKey === key}
              className={assetKey === key ? "active" : ""}
              key={key}
              onClick={() => setAssetKey(key)}
              role="tab"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <button className="refreshButton" type="button" onClick={() => void loadData()} disabled={loading}>
          <RefreshCw size={16} />
          <span>{loading ? "갱신 중" : "새로고침"}</span>
        </button>
      </header>

      {error && <div className="errorBanner">{error}</div>}

      <section className={`decisionPanel ${assessmentReady ? indicator.signal.direction : "pending"}`}>
        <div>
          <span>현재 판단</span>
          <strong>{assessmentReady ? indicator.signal.label : loading ? "분석 중" : "평가 보류"}</strong>
          <p>
            {assessmentReady
              ? indicator.signal.reasons[0] ?? "판단 근거를 계산하지 못했습니다."
              : loading
                ? "필수 데이터를 모두 수집한 뒤 점수를 표시합니다."
                : "필수 데이터 일부를 불러오지 못해 점수를 표시하지 않습니다."}
          </p>
        </div>
        {assessmentReady && (
          <div className="decisionScore">
            <strong>{indicator.signal.score}</strong>
            <small>종합 점수</small>
            <small>신뢰도 {indicator.signal.confidence}%</small>
          </div>
        )}
      </section>

      <section className="metricGrid">
        <div className="metric">
          <span>현재가</span>
          <strong>{formatUsdt(ticker?.price ?? indicator.price)} USDT</strong>
          <b className="krwPrice">약 {formatKrw((ticker?.price ?? indicator.price) !== null && fxRate ? (ticker?.price ?? indicator.price ?? 0) * fxRate.rate : null)}</b>
          <small>
            {updatedAt ? `${updatedAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 갱신` : "대기"}
            {fxRate ? ` · 환율 ${formatNumber(fxRate.rate, 1)}원` : ""}
          </small>
        </div>
        <div className="metric">
          <span>24시간 변화</span>
          <strong className={ticker && ticker.changePercent >= 0 ? "upText" : "downText"}>{formatPercent(ticker?.changePercent ?? null)}</strong>
          <small>Binance 24hr ticker</small>
        </div>
        <div className="metric">
          <span>RSI</span>
          <strong>{formatNumber(indicator.rsi)}</strong>
          <small>{indicator.rsi !== null && indicator.rsi <= 30 ? "과매도" : indicator.rsi !== null && indicator.rsi >= 70 ? "과열" : "중립"}</small>
        </div>
        <div className="metric">
          <span>20주 평균선</span>
          <strong>{formatUsdt(indicator.sma20w)} USDT</strong>
          <small>{indicator.price && indicator.sma20w ? (indicator.price >= indicator.sma20w ? "현재가 위" : "현재가 아래") : "대기"}</small>
        </div>
        <div className="metric">
          <span>시가총액 순위</span>
          <strong>#{marketInfo?.rank ?? "-"}</strong>
          <small>스테이블 코인 제외 · {formatUsdCompact(marketInfo?.marketCap ?? null)}</small>
        </div>
        <div className="metric">
          <span>24시간 거래대금</span>
          <strong>{formatUsdCompact(ticker?.quoteVolume ?? null)}</strong>
          <small>Binance {asset.binanceSymbol}</small>
        </div>
        <div className="metric">
          <span>7일 / 30일</span>
          <strong>
            {formatPercent(indicator.change7d)} / {formatPercent(indicator.change30d)}
          </strong>
          <small>Binance 일봉 기준</small>
        </div>
        <div className="metric">
          <span>개발 지수</span>
          <strong className={assessmentReady ? developmentTone(indicator.signal.developmentIndex) : undefined}>
            {assessmentReady && indicator.signal.developmentIndex >= 0 ? indicator.signal.developmentIndex : "-"}
          </strong>
          <small>{assessmentReady ? `${developmentLabel(indicator.signal.developmentIndex)} · 공식 GitHub ${asset.repos.length}개` : "데이터 확인 중"}</small>
        </div>
        <div className="metric">
          <span>BTC 시장 환경</span>
          <strong className={macroInfo?.btcEma200 && macroInfo.btcPrice >= macroInfo.btcEma200 ? "upText" : "downText"}>
            {macroInfo?.btcEma200 ? (macroInfo.btcPrice >= macroInfo.btcEma200 ? "우호" : "방어") : "-"}
          </strong>
          <small>BTC 200일선 · 24시간 {formatPercent(macroInfo?.btcChange24h ?? null)}</small>
        </div>
        <div className="metric">
          <span>{asset.symbol}/BTC 상대 강도</span>
          <strong className={(macroInfo?.assetBtcChange7d ?? 0) >= 0 ? "upText" : "downText"}>{formatPercent(macroInfo?.assetBtcChange7d ?? null)}</strong>
          <small>최근 7일 · BTC 대비</small>
        </div>
        <div className="metric">
          <span>신호 신뢰도</span>
          <strong className={assessmentReady && indicator.signal.confidence >= 70 ? "upText" : "watchText"}>{assessmentReady ? `${indicator.signal.confidence}%` : "-"}</strong>
          <small>ADX·데이터 완성도·점수 강도</small>
        </div>
        <div className="metric">
          <span>변동 위험</span>
          <strong className={indicator.signal.riskLevel === "high" ? "downText" : indicator.signal.riskLevel === "medium" ? "watchText" : "upText"}>
            {indicator.signal.riskLevel === "high" ? "높음" : indicator.signal.riskLevel === "medium" ? "보통" : indicator.signal.riskLevel === "low" ? "낮음" : "-"}
          </strong>
          <small>ATR {indicator.price && indicator.atr ? formatPercent((indicator.atr / indicator.price) * 100) : "-"}</small>
        </div>
      </section>

      <div className="rangeControls" aria-label="그래프 기간">
        {CHART_RANGES.map((item) => (
          <button className={range === item.value ? "active" : ""} key={item.value} type="button" onClick={() => setRange(item.value)}>
            {item.label}
          </button>
        ))}
      </div>

      <DotChart asset={asset} candles={candles} range={range} />

      <section className="panel reasonPanel">
        <div className="panelTitle">
          <Activity size={18} />
          <h2>판단 이유</h2>
        </div>
        <div className="reasonList">
          {assessmentReady ? (
            indicator.signal.reasons.map((reason) => <div key={reason}>{reason}</div>)
          ) : (
            <div>{loading ? `${asset.symbol} 가격·뉴스·개발 데이터를 수집하고 있습니다.` : "필수 데이터가 완성되지 않아 판단을 보류했습니다."}</div>
          )}
        </div>
      </section>

      <section className="contextGrid">
        <div className="panel contextPanel">
          <div className="panelTitle">
            <TrendingUp size={18} />
            <h2>Binance 선물 수급</h2>
          </div>
          <dl>
            <div><dt>펀딩비</dt><dd className={(derivativesInfo?.fundingRatePercent ?? 0) > 0.05 ? "downText" : "upText"}>{formatPercent(derivativesInfo?.fundingRatePercent ?? null)}</dd></div>
            <div><dt>미결제약정</dt><dd>{formatUsdCompact(derivativesInfo?.openInterestUsd ?? null)}</dd></div>
            <div><dt>24시간 OI 변화</dt><dd className={(derivativesInfo?.openInterestChange24h ?? 0) >= 0 ? "upText" : "downText"}>{formatPercent(derivativesInfo?.openInterestChange24h ?? null)}</dd></div>
            <div><dt>롱/숏 계정 비율</dt><dd>{formatNumber(derivativesInfo?.longShortRatio ?? null)}x</dd></div>
          </dl>
        </div>

        {asset.networkAdapter === "polkadot" && <div className="panel contextPanel">
          <div className="panelTitle">
            <ShieldCheck size={18} />
            <h2>Polkadot 온체인</h2>
          </div>
          <dl>
            <div><dt>스테이킹 비율</dt><dd>{formatPercent(onchainInfo?.stakedPercent ?? null)}</dd></div>
            <div><dt>총 스테이킹</dt><dd>{formatNumber(onchainInfo?.totalStaked ?? null, 0)} DOT</dd></div>
            <div><dt>활성 검증인</dt><dd>{formatNumber(onchainInfo?.activeValidators ?? null, 0)}</dd></div>
            <div><dt>노미네이터</dt><dd>{formatNumber(onchainInfo?.nominatorCount ?? null, 0)}</dd></div>
            <div><dt>최근 블록 호출</dt><dd>{formatNumber(onchainInfo?.averageExtrinsics ?? null, 0)}건</dd></div>
          </dl>
          <small>{onchainInfo?.cached ? `Firebase 스냅샷${onchainInfo.updatedAt ? ` · ${formatDate(onchainInfo.updatedAt)}` : ""}` : onchainInfo ? "실시간 Polkadot RPC" : "온체인 데이터 확인 중"}</small>
        </div>}

        {asset.networkAdapter === "polkadot" && <a className="panel contextPanel etfPanel" href="https://www.21shares.com/en-us/products-us/tdot" rel="noreferrer" target="_blank">
          <div className="panelTitle">
            <Landmark size={18} />
            <h2>21Shares TDOT ETF</h2>
            <ExternalLink size={13} />
          </div>
          <dl>
            <div><dt>NAV / 시장가</dt><dd>${formatUsdt(etfInfo?.nav ?? null)} / ${formatUsdt(etfInfo?.marketPrice ?? null)}</dd></div>
            <div><dt>순자산 AUM</dt><dd>{formatUsdCompact(etfInfo?.aum ?? null)}</dd></div>
            <div><dt>보유 DOT</dt><dd>{formatNumber(etfInfo?.dotHoldings ?? null, 0)} DOT</dd></div>
            <div><dt>5거래일 AUM</dt><dd className={(etfInfo?.aumChange5d ?? 0) >= 0 ? "upText" : "downText"}>{formatPercent(etfInfo?.aumChange5d ?? null)}</dd></div>
            <div><dt>프리미엄/할인</dt><dd>{formatPercent(etfInfo?.premiumDiscount ?? null)}</dd></div>
            <div><dt>거래량 배율</dt><dd>{etfInfo?.volumeRatio !== null && etfInfo?.volumeRatio !== undefined ? `${formatNumber(etfInfo.volumeRatio)}x` : "-"}</dd></div>
          </dl>
          <small>{etfInfo ? `${formatDate(etfInfo.valuationDate)} 기준 · Nasdaq TDOT` : "공식 ETF 데이터 확인 중"}</small>
        </a>}

        {asset.networkAdapter === "xrpl" && <a className="panel contextPanel" href="https://livenet.xrpl.org/" rel="noreferrer" target="_blank">
          <div className="panelTitle"><Network size={18} /><h2>XRPL 네트워크</h2><ExternalLink size={13} /></div>
          <dl>
            <div><dt>검증 원장</dt><dd>#{formatNumber(xrplInfo?.ledgerIndex ?? null, 0)}</dd></div>
            <div><dt>원장 지연</dt><dd>{xrplInfo ? `${xrplInfo.ledgerAge}초` : "-"}</dd></div>
            <div><dt>기본 수수료</dt><dd>{xrplInfo ? `${xrplInfo.baseFeeXrp} XRP` : "-"}</dd></div>
            <div><dt>부하 지수</dt><dd>{formatNumber(xrplInfo?.loadFactor ?? null)}x</dd></div>
            <div><dt>서버 상태</dt><dd className={xrplInfo?.networkHealthy ? "upText" : "downText"}>{xrplInfo?.serverState ?? "-"}</dd></div>
          </dl>
          <small>rippled {xrplInfo?.buildVersion ?? "-"} · 피어 {formatNumber(xrplInfo?.peers ?? null, 0)}</small>
        </a>}

        {asset.networkAdapter === "avalanche" && <a className="panel contextPanel" href="https://subnets.avax.network/c-chain" rel="noreferrer" target="_blank">
          <div className="panelTitle"><Network size={18} /><h2>Avalanche 네트워크</h2><ExternalLink size={13} /></div>
          <dl>
            <div><dt>네트워크</dt><dd>{avalancheInfo?.networkId === 1 ? "Mainnet" : "-"}</dd></div>
            <div><dt>C-Chain 블록</dt><dd>#{formatNumber(avalancheInfo?.blockNumber ?? null, 0)}</dd></div>
            <div><dt>노드 상태</dt><dd className={avalancheInfo?.networkHealthy ? "upText" : "downText"}>{avalancheInfo?.networkHealthy ? "정상" : "확인 중"}</dd></div>
          </dl>
          <small>{avalancheInfo?.nodeVersion ?? "노드 버전 확인 중"}</small>
        </a>}

        {asset.networkAdapter === "none" && <a className="panel contextPanel" href={asset.officialNewsUrl} rel="noreferrer" target="_blank">
          <div className="panelTitle"><Network size={18} /><h2>{asset.label} 개발 상태</h2><ExternalLink size={13} /></div>
          <dl>
            <div><dt>개발 지수</dt><dd>{assessmentReady && indicator.signal.developmentIndex >= 0 ? indicator.signal.developmentIndex : "-"}</dd></div>
            <div><dt>추적 저장소</dt><dd>{asset.repos.length}개</dd></div>
            <div><dt>최근 활동</dt><dd>{devItems[0] ? formatDate(devItems[0].date) : "-"}</dd></div>
          </dl>
          <small>{asset.repos.map((repo) => repo.label).join(" · ")} 종합</small>
        </a>}
      </section>

      {asset.networkAdapter === "polkadot" && <section className="fundamentalGrid">
        <a className="panel fundamentalPanel" href="https://staking.polkadot.cloud/" rel="noreferrer" target="_blank">
          <div className="panelTitle">
            <ShieldCheck size={18} />
            <h2>스테이킹 상태</h2>
            <ExternalLink size={13} />
          </div>
          <strong>{formatPercent(onchainInfo?.stakedPercent ?? null)}</strong>
          <p>{formatNumber(onchainInfo?.totalStaked ?? null, 0)} DOT 스테이킹 · 활성 검증인 {formatNumber(onchainInfo?.activeValidators ?? null, 0)}</p>
          <small>노미네이터 {formatNumber(onchainInfo?.nominatorCount ?? null, 0)}명</small>
        </a>

        <div className="panel fundamentalPanel">
          <div className="panelTitle">
            <Coins size={18} />
            <h2>공급·인플레이션</h2>
          </div>
          <strong>{formatNumber(onchainInfo?.totalIssuance ?? marketInfo?.totalSupply ?? null, 0)} DOT</strong>
          <p>연간 신규 발행량 1억 2천만 DOT</p>
          <small>
            현재 총공급 대비 약 {(onchainInfo?.totalIssuance ?? marketInfo?.totalSupply) ? formatPercent((120_000_000 / (onchainInfo?.totalIssuance ?? marketInfo?.totalSupply ?? 1)) * 100) : "-"}
          </small>
        </div>

        <a className="panel fundamentalPanel" href="https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Frpc.polkadot.io#/explorer" rel="noreferrer" target="_blank">
          <div className="panelTitle">
            <Network size={18} />
            <h2>네트워크 상태</h2>
            <ExternalLink size={13} />
          </div>
          <strong>{networkInfo ? (networkInfo.syncing ? "동기화 중" : "정상") : "연결 확인 중"}</strong>
          <p>
            확정 지연 {networkInfo ? `${formatNumber(networkInfo.bestBlock - networkInfo.finalizedBlock, 0)}블록` : "-"} · 피어 {networkInfo ? formatNumber(networkInfo.peers, 0) : "-"}
          </p>
          <small>런타임 v{networkInfo?.runtimeVersion ?? "-"} · 최신 #{networkInfo ? formatNumber(networkInfo.bestBlock, 0) : "-"}</small>
        </a>

        <a className="panel fundamentalPanel" href="https://polkadot.subsquare.io/referenda?ongoing=true" rel="noreferrer" target="_blank">
          <div className="panelTitle">
            <Landmark size={18} />
            <h2>중요 OpenGov</h2>
            <ExternalLink size={13} />
          </div>
          <strong>누적 #{formatNumber(onchainInfo?.referendumCount ?? null, 0)}</strong>
          <p>{onchainInfo && onchainInfo.recentOngoingReferenda >= 0 ? `최근 12개 중 진행 ${formatNumber(onchainInfo.recentOngoingReferenda, 0)}건` : "진행 상태는 OpenGov에서 확인"}</p>
          <small>런타임·Treasury·스테이킹 변경 추적</small>
        </a>
      </section>}

      {asset.networkAdapter !== "polkadot" && <section className="fundamentalGrid compactFundamentals">
        <div className="panel fundamentalPanel">
          <div className="panelTitle"><Coins size={18} /><h2>{asset.label} 공급 현황</h2></div>
          <strong>{formatAssetAmount(marketInfo?.circulatingSupply, asset.symbol)}</strong>
          <p>유통량 / 총공급 {formatPercent(marketInfo?.circulatingSupply && marketInfo.totalSupply ? (marketInfo.circulatingSupply / marketInfo.totalSupply) * 100 : null)}</p>
          <small>총공급 {formatAssetAmount(marketInfo?.totalSupply, asset.symbol)}</small>
        </div>
        <a className="panel fundamentalPanel" href={asset.officialNewsUrl} rel="noreferrer" target="_blank">
          <div className="panelTitle"><Newspaper size={18} /><h2>{asset.label} 공식 정보</h2><ExternalLink size={13} /></div>
          <strong>{news.length}건 추적</strong>
          <p>최신 뉴스와 공식 개발 공지를 함께 평가합니다.</p>
          <small>공식 채널 열기</small>
        </a>
      </section>}

      {asset.ecosystemCategory && <section className="panel ecosystemPanel">
        <div className="ecosystemTitle">
          <div className="panelTitle">
            <Network size={18} />
            <h2>{asset.label} {asset.ecosystemTitle}</h2>
          </div>
          <span>{asset.ecosystemTitle} 시가총액 순위 · {asset.symbol}·스테이블 코인 제외</span>
        </div>
        <div className="newProjectTracker">
          <div>
            <strong>신규 합류 프로젝트</strong>
            <span>최근 90일 · Firebase 스냅샷 비교</span>
          </div>
          {newEcosystemProjects.length ? (
            <div className="newProjectList">
              {newEcosystemProjects.map((project) => (
                <a href={`https://www.coingecko.com/en/coins/${project.id}`} key={project.id} rel="noreferrer" target="_blank">
                  {project.image && <img alt="" height="22" src={project.image} width="22" />}
                  <span>
                    <b>{project.name}</b>
                    <small>{project.symbol} · {formatDate(project.firstSeen)} 감지</small>
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <p>현재 새로 감지된 프로젝트가 없습니다. 새 프로젝트가 분류에 추가되면 여기에 표시됩니다.</p>
          )}
        </div>
        <div className="ecosystemTable" role="table" aria-label={`${asset.label} ${asset.ecosystemTitle} 시세`}>
          <div className="ecosystemHead" role="row">
            <span>순위 / 프로젝트</span>
            <span>현재가</span>
            <span>24시간</span>
            <span>시가총액</span>
          </div>
          <div className="ecosystemRows">
            {ecosystemProjects.map((project, index) => (
              <a href={`https://www.coingecko.com/en/coins/${project.id}`} key={project.id} rel="noreferrer" role="row" target="_blank">
                <div className="projectIdentity">
                  <b>#{index + 1}</b>
                  <img alt="" height="28" loading="lazy" src={project.image} width="28" />
                  <div>
                    <strong>{project.name}</strong>
                    <span>{project.symbol}</span>
                  </div>
                </div>
                <div className="projectValue projectPrice">
                  <small>현재가</small>
                  <strong>{formatUsdPrice(project.price)}</strong>
                </div>
                <div className="projectValue projectChange">
                  <small>24시간</small>
                  <strong className={(project.change24h ?? 0) >= 0 ? "upText" : "downText"}>{formatPercent(project.change24h)}</strong>
                </div>
                <div className="projectValue projectMarketCap">
                  <small>시가총액</small>
                  <strong>{formatUsdCompact(project.marketCap)}</strong>
                </div>
              </a>
            ))}
            {!ecosystemProjects.length && (
              <div className="ecosystemEmpty">
                {ecosystemError ? `CoinGecko ${friendlyDataError(ecosystemError)}` : "생태계 시세를 불러오는 중입니다."}
              </div>
            )}
          </div>
        </div>
      </section>}

      <section className="detailGrid">
        <div className="panel indicatorPanel">
          <div className="panelTitle">
            <TrendingUp size={18} />
            <h2>기술 지표</h2>
          </div>
          <dl>
            <div>
              <dt>
                <span>장기 추세선</span>
                <small>50일 평균 / 200일 평균</small>
              </dt>
              <dd>
                {formatUsdt(indicator.ema50)} / {formatUsdt(indicator.ema200)}
                <small>{indicator.ema50 !== null && indicator.ema200 !== null ? (indicator.ema50 > indicator.ema200 ? "상승 흐름" : "하락 흐름") : "계산 중"}</small>
              </dd>
            </div>
            <div>
              <dt>
                <span>단기 가격 힘</span>
                <small>0보다 크면 상승 힘 우세</small>
              </dt>
              <dd>
                {formatNumber(indicator.macd.histogram, 5)}
                <small>{indicator.macd.histogram !== null ? (indicator.macd.histogram > 0 ? "상승 힘 우세" : "하락 힘 우세") : "계산 중"}</small>
              </dd>
            </div>
            <div>
              <dt>거래량 배율</dt>
              <dd>{indicator.volumeRatio ? `${formatNumber(indicator.volumeRatio)}x` : "-"}</dd>
            </div>
            <div>
              <dt><span>ADX</span><small>25 이상이면 추세 신뢰</small></dt>
              <dd>{formatNumber(indicator.adx)}<small>{indicator.adx !== null ? (indicator.adx >= 25 ? "추세 뚜렷" : indicator.adx < 20 ? "횡보 가능" : "추세 형성 중") : "계산 중"}</small></dd>
            </div>
            <div>
              <dt><span>ATR 변동성</span><small>가격 대비 일간 변동 폭</small></dt>
              <dd>{indicator.price && indicator.atr ? formatPercent((indicator.atr / indicator.price) * 100) : "-"}<small>ATR {formatUsdt(indicator.atr)} USDT</small></dd>
            </div>
            <div>
              <dt><span>볼린저 밴드</span><small>하단 0% · 상단 100%</small></dt>
              <dd>{indicator.bollinger.position !== null ? `${formatNumber(indicator.bollinger.position * 100, 1)}%` : "-"}<small>밴드 폭 {formatPercent(indicator.bollinger.widthPercent)}</small></dd>
            </div>
            <div>
              <dt>피보나치 위치</dt>
              <dd>{indicator.fibPosition !== null ? `${formatNumber(indicator.fibPosition, 1)}%` : "-"}</dd>
            </div>
            <div>
              <dt>1년 고점 / 저점</dt>
              <dd>{formatUsdt(indicator.yearlyHigh)} / {formatUsdt(indicator.yearlyLow)}</dd>
            </div>
            <div>
              <dt>유통량</dt>
              <dd>{formatNumber(marketInfo?.circulatingSupply ?? null, 0)} {asset.symbol}</dd>
            </div>
          </dl>
        </div>

        <div className="panel newsPanel">
          <div className="panelTitle">
            <Newspaper size={18} />
            <h2>{asset.symbol} 뉴스</h2>
          </div>
          <div className="linkList">
            {news.map((item) => (
              <a href={item.url} key={item.id} rel="noreferrer" target="_blank">
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.source} · {formatDate(item.publishedAt)} · {item.sentiment > 0 ? "긍정" : item.sentiment < 0 ? "부정" : "중립"}
                  </span>
                </div>
                <ExternalLink size={14} />
              </a>
            ))}
          </div>
        </div>

        <div className="panel devPanel">
          <div className="panelTitle">
            <Code2 size={18} />
            <h2>{asset.symbol} 개발 GitHub</h2>
          </div>
          <div className="repoTracker">
            {asset.repos.map((repo) => {
              const latest = devItems.find((item) => item.repo === repo.repo);
              const count = devItems.filter((item) => item.repo === repo.repo && item.type === "commit").length;
              return (
                <a href={`https://github.com/${repo.owner}/${repo.repo}`} key={repo.repo} rel="noreferrer" target="_blank">
                  <div>
                    <strong>{repo.label}</strong>
                    <span>{repo.role}</span>
                  </div>
                  <b>{count}건 · {latest ? formatDate(latest.date) : "대기"}</b>
                </a>
              );
            })}
          </div>
          <div className="linkList">
            {devItems.length ? devItems.map((item) => (
              <a href={item.url} key={item.id} rel="noreferrer" target="_blank">
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.type === "release" ? "Release" : "Commit"} · {item.repo} · {formatDate(item.date)}
                  </span>
                </div>
                {item.type === "release" ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
              </a>
            )) : <div className="emptyList">GitHub 제한으로 최신 개발 내역을 확인 중입니다.</div>}
          </div>
        </div>
      </section>
    </main>
  );
}
