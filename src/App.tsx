import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Code2, Coins, ExternalLink, Landmark, Network, Newspaper, RefreshCw, ShieldCheck, TrendingUp } from "lucide-react";

const SYMBOL = "DOTUSDT";
const DEV_REPOS = [
  { owner: "paritytech", repo: "polkadot-sdk", label: "Polkadot SDK", role: "코어 SDK" },
  { owner: "polkadot-fellows", repo: "runtimes", label: "Polkadot Runtimes", role: "실제 네트워크 런타임" },
  { owner: "w3f", repo: "polkadot-spec", label: "Polkadot Spec", role: "프로토콜 명세" },
] as const;
const CHART_RANGES = [
  { label: "1주", value: "7d", days: 7 },
  { label: "1개월", value: "1m", days: 30 },
  { label: "3개월", value: "3m", days: 90 },
  { label: "6개월", value: "6m", days: 180 },
  { label: "1년", value: "1y", days: 365 },
] as const;
const BINANCE_BASES = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];
const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "USDS", "DAI", "FDUSD", "TUSD", "USDE", "USDD", "USDP", "PYUSD", "USD1", "GUSD", "FRAX", "LUSD", "SUSD", "BUSD",
  "RLUSD", "USD0", "USDY", "USYC", "USUALUSD", "USDTB", "SUSDS", "SUSDE", "EURC", "EURS", "EURT", "EURI", "AEUR", "EURCV",
]);

type ChartRange = (typeof CHART_RANGES)[number]["value"];
type SignalDirection = "buy" | "risk" | "neutral";

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

interface EcosystemProject {
  id: string;
  name: string;
  symbol: string;
  image: string;
  price: number | null;
  marketCap: number | null;
  change24h: number | null;
  launchDate: string | null;
  description: string;
  dotHoldings: number | null;
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

function isStableCoin(coin: { symbol: string; name: string }) {
  const symbol = coin.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return STABLE_SYMBOLS.has(symbol) || /stablecoin|\busd\b|dollar|\beuro\b/i.test(coin.name);
}

function formatDate(value: number | string) {
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(new Date(value));
}

function formatLaunchDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
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

function calculateDevelopmentIndex(devItems: DevItem[]) {
  const now = Date.now();
  const commits = devItems.filter((item) => item.type === "commit");
  const releases = devItems.filter((item) => item.type === "release");
  const commits30d = commits.filter((item) => now - new Date(item.date).getTime() <= 30 * 86_400_000);
  const activeRepos = new Set(commits30d.map((item) => item.repo)).size;
  const latestCommitAt = commits.reduce((latest, item) => Math.max(latest, new Date(item.date).getTime()), 0);
  const latestCommitDays = latestCommitAt ? (now - latestCommitAt) / 86_400_000 : Number.POSITIVE_INFINITY;
  const recencyScore = latestCommitDays <= 2 ? 40 : latestCommitDays <= 7 ? 34 : latestCommitDays <= 14 ? 26 : latestCommitDays <= 30 ? 16 : latestCommitDays <= 60 ? 8 : 0;
  const breadthScore = Math.min(25, (activeRepos / DEV_REPOS.length) * 25);
  const cadenceScore = Math.min(20, (commits30d.length / (DEV_REPOS.length * 4)) * 20);
  const latestReleaseAt = releases.reduce((latest, item) => Math.max(latest, new Date(item.date).getTime()), 0);
  const latestReleaseDays = latestReleaseAt ? (now - latestReleaseAt) / 86_400_000 : Number.POSITIVE_INFINITY;
  const releaseScore = latestReleaseDays <= 90 ? 15 : latestReleaseDays <= 180 ? 8 : 0;
  return Math.round(Math.min(100, recencyScore + breadthScore + cadenceScore + releaseScore));
}

function developmentScore(index: number) {
  if (index >= 80) return 12;
  if (index >= 65) return 8;
  if (index >= 50) return 3;
  if (index >= 35) return -3;
  if (index >= 20) return -8;
  return -12;
}

function developmentLabel(index: number) {
  if (index >= 70) return "개발 매우 활발";
  if (index >= 40) return "개발 정상 진행";
  if (index >= 20) return "개발 활동 둔화";
  return "개발 장기 정체";
}

function buildSignal(candles: Candle[], change24h: number | null, change7d: number | null, news: NewsItem[], devItems: DevItem[], networkInfo: NetworkInfo | null): DotSignal {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const price = closes[closes.length - 1] ?? 0;
  const previous = closes[closes.length - 2] ?? price;
  const rsi = calculateRsi(closes);
  const ema50 = calculateEma(closes, 50);
  const ema200 = calculateEma(closes, 200);
  const sma20w = calculateSma(closes, 140);
  const { histogram } = calculateMacd(closes);
  const volumeRatio = average(volumes.slice(-21, -1)) ? (volumes[volumes.length - 1] ?? 0) / average(volumes.slice(-21, -1)) : null;
  const reasons: string[] = [];
  let score = 0;

  if (rsi !== null) {
    if (rsi <= 30) {
      score += 22;
      reasons.push(`RSI ${formatNumber(rsi)}: 과매도 구간이라 반등 후보`);
    } else if (rsi >= 70) {
      score -= 22;
      reasons.push(`RSI ${formatNumber(rsi)}: 과열 구간이라 추격 매수 위험`);
    } else {
      reasons.push(`RSI ${formatNumber(rsi)}: 중립 구간`);
    }
  }

  if (ema50 !== null && ema200 !== null) {
    if (price > ema50 && ema50 > ema200) {
      score += 20;
      reasons.push("50일 추세선이 200일 추세선 위이고 현재가도 위라 장기 상승 흐름");
    } else if (price < ema50 && ema50 < ema200) {
      score -= 20;
      reasons.push("50일 추세선이 200일 추세선 아래이고 현재가도 아래라 장기 하락 흐름");
    } else {
      reasons.push("50일·200일 추세선이 엇갈려 장기 방향이 아직 불분명");
    }
  }

  if (sma20w !== null) {
    if (price > sma20w) {
      score += 12;
      reasons.push(`현재가가 20주 평균선 ${formatUsdt(sma20w)} USDT 위`);
    } else {
      score -= 12;
      reasons.push(`현재가가 20주 평균선 ${formatUsdt(sma20w)} USDT 아래`);
    }
  }

  if (histogram !== null) {
    if (histogram > 0) {
      score += 10;
      reasons.push("단기 상승 힘이 하락 힘보다 강해지는 중");
    } else {
      score -= 10;
      reasons.push("단기 하락 힘이 상승 힘보다 강한 상태");
    }
  }

  if (volumeRatio !== null && volumeRatio >= 1.5) {
    score += price >= previous ? 10 : -10;
    reasons.push(`거래량이 20일 평균의 ${formatNumber(volumeRatio)}배로 커짐`);
  }

  if (change24h !== null) {
    if (change24h >= 10) {
      score += 8;
      reasons.push("24시간 10% 이상 상승: 강한 수급 유입");
    } else if (change24h <= -8) {
      score -= 8;
      reasons.push("24시간 낙폭이 커서 단기 하락 위험");
    }
  }

  if (change7d !== null) {
    if (change7d > 8) {
      score += 6;
      reasons.push(`Binance 7일 수익률 ${formatPercent(change7d)}: 단기 추세 강함`);
    } else if (change7d < -8) {
      score -= 6;
      reasons.push(`Binance 7일 수익률 ${formatPercent(change7d)}: 단기 약세`);
    }
  }

  const scoredNews = news.filter((item) => item.sentiment !== 0);
  const newsBalance = scoredNews.reduce((sum, item) => sum + item.sentiment, 0);
  if (newsBalance >= 2) {
    score += Math.min(12, 4 + newsBalance * 2);
    reasons.push(`DOT 뉴스 ${news.length}건 중 긍정 재료 우세: 전망에 가점`);
  } else if (newsBalance <= -2) {
    score -= Math.min(12, 4 + Math.abs(newsBalance) * 2);
    reasons.push(`DOT 뉴스 ${news.length}건 중 부정 재료 우세: 전망에 감점`);
  } else {
    reasons.push(`DOT 뉴스 ${news.length}건: 뚜렷한 긍정·부정 우위 없음`);
  }

  const developmentIndex = calculateDevelopmentIndex(devItems);
  const developmentContribution = developmentScore(developmentIndex);
  score += developmentContribution;
  reasons.push(`개발 지수 ${developmentIndex}점 · ${developmentLabel(developmentIndex)}: 종합점수 ${developmentContribution > 0 ? "+" : ""}${developmentContribution}`);

  if (networkInfo) {
    const finalityGap = networkInfo.bestBlock - networkInfo.finalizedBlock;
    if (networkInfo.syncing || finalityGap > 5) {
      score -= 12;
      reasons.push(`네트워크 확정 지연 ${formatNumber(finalityGap, 0)}블록: 운영 위험 감점`);
    } else {
      score += 2;
      reasons.push(`네트워크 정상: 최신 블록과 확정 블록 차이 ${formatNumber(finalityGap, 0)}개`);
    }
  }

  const direction: SignalDirection = score >= 35 ? "buy" : score <= -35 ? "risk" : "neutral";
  return {
    direction,
    score: Math.round(score),
    developmentIndex,
    label: direction === "buy" ? "매수" : direction === "risk" ? "매도" : "관망",
    reasons,
  };
}

async function fetchBinanceJson(path: string) {
  const errors: string[] = [];
  for (const base of BINANCE_BASES) {
    const response = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
    if (response.ok) return response.json();
    errors.push(`${base} ${response.status}`);
  }
  throw new Error(`Binance 데이터 요청 실패: ${errors.join(", ")}`);
}

async function fetchCandles() {
  const rows = (await fetchBinanceJson(`/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=365`)) as Array<[number, string, string, string, string, string]>;
  return rows.map((row) => ({
    openTime: Number(row[0]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  }));
}

async function fetchTicker24h() {
  const row = (await fetchBinanceJson(`/api/v3/ticker/24hr?symbol=${SYMBOL}`)) as { lastPrice: string; priceChangePercent: string; volume: string; quoteVolume: string };
  return {
    price: Number(row.lastPrice),
    changePercent: Number(row.priceChangePercent),
    volume: Number(row.volume),
    quoteVolume: Number(row.quoteVolume),
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

async function polkadotRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch("https://rpc.polkadot.io", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  if (!response.ok) throw new Error(`Polkadot RPC 요청 실패: ${response.status}`);
  const data = (await response.json()) as { result?: T; error?: { message?: string } };
  if (data.error || data.result === undefined) throw new Error(data.error?.message || `${method} 응답 오류`);
  return data.result;
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

async function fetchNews(): Promise<NewsItem[]> {
  try {
    const response = await fetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("news failed");
    const data = (await response.json()) as {
      Data?: Array<{ body?: string; id: string; title: string; source_info?: { name?: string }; url: string; published_on: number }>;
    };
    const rows = data.Data ?? [];
    const filtered = rows.filter((item) => /polkadot|\bdot\b|parity|web3 foundation/i.test(`${item.title} ${item.body ?? ""}`));
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
        id: "polkadot-blog",
        title: "Polkadot 공식 블로그에서 최신 생태계 소식 확인",
        source: "Polkadot",
        url: "https://polkadot.com/blog",
        publishedAt: Date.now(),
        sentiment: 0,
      },
      {
        id: "polkadot-forum",
        title: "Polkadot Forum에서 거버넌스와 개발 논의 확인",
        source: "Polkadot Forum",
        url: "https://forum.polkadot.network/",
        publishedAt: Date.now(),
        sentiment: 0,
      },
    ];
  }
}

async function fetchMarketInfo(): Promise<DotMarketInfo> {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", "250");
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`CoinGecko DOT 데이터 요청 실패: ${response.status}`);
  const rows = (await response.json()) as Array<{
    id: string;
    symbol: string;
    name: string;
    market_cap: number | null;
    circulating_supply: number | null;
    total_supply: number | null;
  }>;
  const withoutStablecoins = rows.filter((coin) => !isStableCoin(coin));
  const dotIndex = withoutStablecoins.findIndex((coin) => coin.id === "polkadot");
  const dot = withoutStablecoins[dotIndex];
  if (!dot || dotIndex < 0) throw new Error("스테이블 코인 제외 순위에서 DOT를 찾지 못했습니다.");

  return {
    rank: dotIndex + 1,
    marketCap: dot.market_cap ?? null,
    circulatingSupply: dot.circulating_supply ?? null,
    totalSupply: dot.total_supply ?? null,
  };
}

async function fetchEcosystemProjects(): Promise<EcosystemProject[]> {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("category", "dot-ecosystem");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", "50");
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");
  url.searchParams.set("price_change_percentage", "24h");
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Polkadot 생태계 요청 실패: ${response.status}`);
  const rows = (await response.json()) as Array<{
    id: string;
    name: string;
    symbol: string;
    image: string;
    current_price: number | null;
    market_cap: number | null;
    price_change_percentage_24h: number | null;
  }>;
  const projects: EcosystemProject[] = rows
    .filter((coin) => coin.id !== "polkadot" && !isStableCoin(coin))
    .slice(0, 20)
    .map((coin) => ({
      id: coin.id,
      name: coin.name,
      symbol: coin.symbol.toUpperCase(),
      image: coin.image,
      price: coin.current_price,
      marketCap: coin.market_cap,
      change24h: coin.price_change_percentage_24h,
      launchDate: null,
      description: "",
      dotHoldings: null,
    }));

  const cacheKey = "dot-ecosystem-details-v2-ko";
  const cached = JSON.parse(window.localStorage.getItem(cacheKey) ?? "{}") as Record<
    string,
    { launchDate: string | null; description: string; cachedAt: number }
  >;
  const cacheMaxAge = 24 * 60 * 60_000;

  await Promise.all(
    projects.map(async (project) => {
        const saved = cached[project.id];
        if (saved && Date.now() - saved.cachedAt < cacheMaxAge) {
          project.launchDate = saved.launchDate;
          project.description = saved.description;
          return;
        }

        try {
          const detailUrl = new URL(`https://api.coingecko.com/api/v3/coins/${project.id}`);
          detailUrl.searchParams.set("localization", "true");
          detailUrl.searchParams.set("tickers", "false");
          detailUrl.searchParams.set("market_data", "false");
          detailUrl.searchParams.set("community_data", "false");
          detailUrl.searchParams.set("developer_data", "false");
          detailUrl.searchParams.set("sparkline", "false");
          const detailResponse = await fetch(detailUrl, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(5_000),
          });
          if (!detailResponse.ok) return;
          const detail = (await detailResponse.json()) as { genesis_date?: string | null; description?: { ko?: string } };
          const parsed = new DOMParser().parseFromString(detail.description?.ko ?? "", "text/html").body.textContent ?? "";
          const description = parsed.replace(/\s+/g, " ").trim();
          project.launchDate = detail.genesis_date ?? null;
          project.description = description;
          cached[project.id] = { launchDate: project.launchDate, description, cachedAt: Date.now() };
        } catch {
          // Individual project details may be unavailable due to public API rate limits.
        }
      }),
  );

  window.localStorage.setItem(cacheKey, JSON.stringify(cached));
  return projects;
}

async function fetchNewEcosystemProjects(currentProjects: EcosystemProject[]): Promise<NewEcosystemProject[]> {
  const [{ collection, getDocs }, { db }] = await Promise.all([import("firebase/firestore"), import("./firebase")]);
  if (db) {
    try {
      const snapshot = await getDocs(collection(db, "ecosystemProjects"));
      if (!snapshot.empty) {
        const cutoff = Date.now() - 90 * 86_400_000;
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
            const current = currentProjects.find((project) => project.id === document.id);
            return {
              id: document.id,
              name: data.name ?? document.id,
              symbol: data.symbol ?? "-",
              image: data.image ?? "",
              price: data.price ?? null,
              marketCap: data.marketCap ?? null,
              change24h: data.change24h ?? null,
              launchDate: current?.launchDate ?? null,
              description: current?.description ?? "",
              dotHoldings: current?.dotHoldings ?? null,
              firstSeen: data.firstSeen?.toMillis?.() ?? 0,
              isBaseline: data.isBaseline ?? true,
            };
          })
          .filter((project) => !project.isBaseline && project.firstSeen >= cutoff)
          .sort((left, right) => right.firstSeen - left.firstSeen)
          .slice(0, 6);
      }
    } catch {
      // Fall back to this browser's previous category snapshot until Firestore rules are deployed.
    }
  }

  const storageKey = "dot-ecosystem-known-projects-v1";
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

async function fetchDevStatus(): Promise<DevItem[]> {
  const repoItems = await Promise.all(
    DEV_REPOS.map(async (repoInfo) => {
      const repoPath = `${repoInfo.owner}/${repoInfo.repo}`;
      const [commitsResponse, releasesResponse] = await Promise.all([
        fetch(`https://api.github.com/repos/${repoPath}/commits?per_page=4`, { headers: { accept: "application/vnd.github+json" } }),
        fetch(`https://api.github.com/repos/${repoPath}/releases?per_page=1`, { headers: { accept: "application/vnd.github+json" } }),
      ]);
      const commits = commitsResponse.ok
        ? ((await commitsResponse.json()) as Array<{ sha: string; html_url: string; commit: { message: string; author?: { date?: string } } }>)
        : [];
      const releases = releasesResponse.ok
        ? ((await releasesResponse.json()) as Array<{ id: number; html_url: string; name?: string; tag_name: string; published_at?: string }>)
        : [];

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
      ];
    }),
  );

  return repoItems
    .flat()
    .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime())
    .slice(0, 15);
}

function DotChart({ candles, range }: { candles: Candle[]; range: ChartRange }) {
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
          <span>DOT 가격 추이</span>
          <strong>{last ? `${formatUsdt(last)} USDT` : "-"}</strong>
          <small>고가 {formatUsdt(max)} · 저가 {formatUsdt(min)}</small>
        </div>
        <b className={change !== null && change >= 0 ? "positive" : "negative"}>{formatPercent(change)}</b>
      </div>
      <div className="chartCanvas">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="DOT 가격 차트. 누르면 해당 날짜의 시세와 거래량을 확인할 수 있습니다."
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
            <span>거래량 <strong>{formatNumber(selectedCandle.volume, 0)} DOT</strong></span>
          </div>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [ticker, setTicker] = useState<{ price: number; changePercent: number; volume: number; quoteVolume: number } | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [devItems, setDevItems] = useState<DevItem[]>([]);
  const [marketInfo, setMarketInfo] = useState<DotMarketInfo | null>(null);
  const [fxRate, setFxRate] = useState<FxRate | null>(null);
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [ecosystemProjects, setEcosystemProjects] = useState<EcosystemProject[]>([]);
  const [newEcosystemProjects, setNewEcosystemProjects] = useState<NewEcosystemProject[]>([]);
  const [range, setRange] = useState<ChartRange>("3m");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
    const volumeRatio = average(volumes.slice(-21, -1)) ? (volumes[volumes.length - 1] ?? 0) / average(volumes.slice(-21, -1)) : null;
    const change7d = calculatePeriodChange(closes, 7);
    const change30d = calculatePeriodChange(closes, 30);
    const yearlyHigh = candles.length ? Math.max(...candles.map((candle) => candle.high)) : null;
    const yearlyLow = candles.length ? Math.min(...candles.map((candle) => candle.low)) : null;
    const fibPosition = price !== null && yearlyHigh !== null && yearlyLow !== null && yearlyHigh > yearlyLow ? ((price - yearlyLow) / (yearlyHigh - yearlyLow)) * 100 : null;
    const signal = buildSignal(candles, ticker?.changePercent ?? null, change7d, news, devItems, networkInfo);

    return { price, sma20w, ema50, ema200, rsi, macd, volumeRatio, yearlyHigh, yearlyLow, fibPosition, change7d, change30d, signal };
  }, [candles, devItems, networkInfo, news, ticker]);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [candlesResult, tickerResult, newsResult, devResult, marketResult, fxResult, networkResult, ecosystemResult] = await Promise.allSettled([
        fetchCandles(),
        fetchTicker24h(),
        fetchNews(),
        fetchDevStatus(),
        fetchMarketInfo(),
        fetchUsdKrw(),
        fetchNetworkInfo(),
        fetchEcosystemProjects(),
      ] as const);

      if (candlesResult.status === "fulfilled") setCandles(candlesResult.value);
      if (tickerResult.status === "fulfilled") setTicker(tickerResult.value);
      if (newsResult.status === "fulfilled") setNews(newsResult.value);
      if (devResult.status === "fulfilled") setDevItems(devResult.value);
      if (marketResult.status === "fulfilled") setMarketInfo(marketResult.value);
      if (fxResult.status === "fulfilled") setFxRate(fxResult.value);
      if (networkResult.status === "fulfilled") setNetworkInfo(networkResult.value);
      if (ecosystemResult.status === "fulfilled") {
        setEcosystemProjects(ecosystemResult.value);
        setNewEcosystemProjects(await fetchNewEcosystemProjects(ecosystemResult.value).catch(() => []));
      }

      const failures = [
        ["가격 차트", candlesResult],
        ["현재가", tickerResult],
        ["뉴스", newsResult],
        ["개발 현황", devResult],
        ["시가총액", marketResult],
        ["환율", fxResult],
        ["네트워크", networkResult],
        ["생태계", ecosystemResult],
      ].flatMap(([name, result]) => (typeof result === "object" && result.status === "rejected" ? [name as string] : []));
      if (failures.length) setError(`일부 데이터 갱신 실패: ${failures.join(", ")}`);
      if (candlesResult.status === "fulfilled" || tickerResult.status === "fulfilled") setUpdatedAt(new Date());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "DOT 데이터를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
    const timer = window.setInterval(() => void loadData(), 10 * 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="dotShell">
      <header className="heroPanel">
        <div>
          <span className="eyebrow">Polkadot only</span>
        </div>
        <button type="button" onClick={() => void loadData()} disabled={loading}>
          <RefreshCw size={16} />
          <span>{loading ? "갱신 중" : "새로고침"}</span>
        </button>
      </header>

      {error && <div className="errorBanner">{error}</div>}

      <section className={`decisionPanel ${indicator.signal.direction}`}>
        <div>
          <span>현재 판단</span>
          <strong>{indicator.signal.label}</strong>
          <p>{indicator.signal.reasons[0] ?? "데이터를 모으는 중입니다."}</p>
        </div>
        <div className="decisionScore">
          <strong>{indicator.signal.score}</strong>
          <small>종합 점수</small>
        </div>
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
          <small>Binance DOTUSDT</small>
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
          <strong className={indicator.signal.developmentIndex >= 70 ? "upText" : indicator.signal.developmentIndex >= 40 ? "watchText" : "downText"}>
            {indicator.signal.developmentIndex}
          </strong>
          <small>{developmentLabel(indicator.signal.developmentIndex)} · 공식 GitHub 3개</small>
        </div>
      </section>

      <div className="rangeControls" aria-label="그래프 기간">
        {CHART_RANGES.map((item) => (
          <button className={range === item.value ? "active" : ""} key={item.value} type="button" onClick={() => setRange(item.value)}>
            {item.label}
          </button>
        ))}
      </div>

      <DotChart candles={candles} range={range} />

      <section className="panel reasonPanel">
        <div className="panelTitle">
          <Activity size={18} />
          <h2>판단 이유</h2>
        </div>
        <div className="reasonList">
          {indicator.signal.reasons.map((reason) => (
            <div key={reason}>{reason}</div>
          ))}
        </div>
      </section>

      <section className="fundamentalGrid">
        <a className="panel fundamentalPanel" href="https://staking.polkadot.cloud/" rel="noreferrer" target="_blank">
          <div className="panelTitle">
            <ShieldCheck size={18} />
            <h2>스테이킹 상태</h2>
            <ExternalLink size={13} />
          </div>
          <strong>공식 현황 확인</strong>
          <p>스테이킹 비율, 예상 보상률, 검증자 상태를 확인합니다.</p>
          <small>노미네이션 풀은 1 DOT부터 참여 가능</small>
        </a>

        <div className="panel fundamentalPanel">
          <div className="panelTitle">
            <Coins size={18} />
            <h2>공급·인플레이션</h2>
          </div>
          <strong>{formatNumber(marketInfo?.totalSupply ?? null, 0)} DOT</strong>
          <p>연간 신규 발행량 1억 2천만 DOT</p>
          <small>
            현재 총공급 대비 약 {marketInfo?.totalSupply ? formatPercent((120_000_000 / marketInfo.totalSupply) * 100) : "-"}
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
          <strong>진행 중 안건 보기</strong>
          <p>런타임 업그레이드, Treasury 지출, 스테이킹 변경을 확인합니다.</p>
          <small>Subsquare Polkadot OpenGov</small>
        </a>
      </section>

      <section className="panel ecosystemPanel">
        <div className="ecosystemTitle">
          <div className="panelTitle">
            <Network size={18} />
            <h2>Polkadot 생태계 프로젝트</h2>
          </div>
          <span>생태계 시가총액 순위 · DOT·스테이블 코인 제외</span>
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
        <div className="ecosystemTable" role="table" aria-label="Polkadot 생태계 프로젝트 시세">
          <div className="ecosystemHead" role="row">
            <span>순위 / 프로젝트</span>
            <span>설명</span>
            <span>출시일</span>
            <span>현재가</span>
            <span>24시간</span>
            <span>시가총액</span>
            <span>공개 보유 DOT</span>
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
                <p className="projectDescription">{project.description}</p>
                <div className="projectValue projectLaunch">
                  <small>출시일</small>
                  <strong>{project.launchDate ? formatLaunchDate(project.launchDate) : ""}</strong>
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
                <div className="projectValue projectHoldings">
                  <small>공개 보유 DOT</small>
                  <strong>{project.dotHoldings !== null ? `${formatNumber(project.dotHoldings)} DOT` : ""}</strong>
                </div>
              </a>
            ))}
            {!ecosystemProjects.length && <div className="ecosystemEmpty">생태계 시세를 불러오는 중입니다.</div>}
          </div>
        </div>
      </section>

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
              <dt>피보나치 위치</dt>
              <dd>{indicator.fibPosition !== null ? `${formatNumber(indicator.fibPosition, 1)}%` : "-"}</dd>
            </div>
            <div>
              <dt>1년 고점 / 저점</dt>
              <dd>{formatUsdt(indicator.yearlyHigh)} / {formatUsdt(indicator.yearlyLow)}</dd>
            </div>
            <div>
              <dt>유통량</dt>
              <dd>{formatNumber(marketInfo?.circulatingSupply ?? null, 0)} DOT</dd>
            </div>
          </dl>
        </div>

        <div className="panel newsPanel">
          <div className="panelTitle">
            <Newspaper size={18} />
            <h2>DOT 뉴스</h2>
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
            <h2>DOT 개발 GitHub</h2>
          </div>
          <div className="repoTracker">
            {DEV_REPOS.map((repo) => {
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
            {devItems.map((item) => (
              <a href={item.url} key={item.id} rel="noreferrer" target="_blank">
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.type === "release" ? "Release" : "Commit"} · {item.repo} · {formatDate(item.date)}
                  </span>
                </div>
                {item.type === "release" ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
              </a>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
