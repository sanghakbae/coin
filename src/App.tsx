import { useEffect, useMemo, useState } from "react";
import { Activity, CandlestickChart, LogIn, LogOut, Plus, Radio, Settings, Trash2 } from "lucide-react";
import { GoogleAuthProvider, User, onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { collection, doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "./firebase";
import type { SignalRecord } from "./types";

const WATCHLIST_STORAGE_KEY = "coin-signal-watchlist";
const CHART_RANGES = [
  { label: "1주", value: "7d", days: 7 },
  { label: "1개월", value: "1m", days: 30 },
  { label: "3개월", value: "3m", days: 90 },
  { label: "6개월", value: "6m", days: 180 },
  { label: "1년", value: "1y", days: 365 },
] as const;
const LIVE_BUY_THRESHOLD = 32;
const LIVE_SELL_THRESHOLD = -32;

type ChartRange = (typeof CHART_RANGES)[number]["value"];

interface BinanceCandle {
  openTime: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

interface MarketCoin {
  id: string;
  name: string;
  symbol: string;
  marketCapRank: number;
  binanceSymbol: string;
}

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

function formatNumber(value: number | null, digits = 2) {
  if (value === null || Number.isNaN(value)) return "-";
  return value.toLocaleString("ko-KR", { maximumFractionDigits: digits });
}

function formatPercent(value: number | null) {
  if (value === null || Number.isNaN(value)) return "-";
  return `${value >= 0 ? "+" : ""}${formatNumber(value)}%`;
}

function formatKrw(value: number | null) {
  if (value === null || Number.isNaN(value)) return "-";
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function displaySymbol(symbol: string) {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

function normalizeWatchSymbol(value: string) {
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return "";
  return cleaned.endsWith("USDT") ? cleaned : `${cleaned}USDT`;
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateSma(values: number[], period: number) {
  if (values.length < period) return null;
  return average(values.slice(-period));
}

function nearestFibLevel(position: number | null) {
  if (position === null) return null;
  const levels = [0, 23.6, 38.2, 50, 61.8, 78.6, 100];
  return levels.reduce((nearest, level) => (Math.abs(level - position) < Math.abs(nearest - position) ? level : nearest), levels[0]);
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

function calculateEma(values: number[], period: number) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = average(values.slice(0, period));

  for (let index = period; index < values.length; index += 1) {
    ema = (values[index] - ema) * multiplier + ema;
  }

  return ema;
}

function buildLiveSignal(coin: MarketCoin, timeframe: string, candles: BinanceCandle[]): SignalRecord {
  const closes = candles.map((candle) => candle.close);
  const times = candles.map((candle) => candle.openTime);
  const volumes = candles.map((candle) => candle.volume);
  const price = closes[closes.length - 1] ?? 0;
  const previous = closes[closes.length - 2] ?? price;
  const rsi = calculateRsi(closes);
  const ema50 = calculateEma(closes, 50);
  const ema200 = calculateEma(closes, 200);
  const sma20w = calculateSma(closes, 140);
  const yearlyHigh = Math.max(...candles.map((candle) => candle.high));
  const yearlyLow = Math.min(...candles.map((candle) => candle.low));
  const fibPosition = yearlyHigh > yearlyLow ? ((price - yearlyLow) / (yearlyHigh - yearlyLow)) * 100 : null;
  const fibNearest = nearestFibLevel(fibPosition);
  const recentAverageVolume = average(volumes.slice(-21, -1));
  const volumeRatio = recentAverageVolume > 0 ? (volumes[volumes.length - 1] ?? 0) / recentAverageVolume : null;
  const trendScore = ema50 !== null && ema200 !== null ? (price > ema50 && ema50 > ema200 ? 18 : price < ema50 && ema50 < ema200 ? -18 : 0) : 0;
  const rsiScore = rsi === null ? 0 : rsi <= 30 ? 14 : rsi >= 70 ? -14 : rsi > 50 ? 6 : -6;
  const volumeScore = volumeRatio !== null && volumeRatio >= 1.5 ? (price >= previous ? 8 : -8) : 0;
  const score = Math.round(trendScore + rsiScore + volumeScore);
  const direction = score >= LIVE_BUY_THRESHOLD ? "buy" : score <= LIVE_SELL_THRESHOLD ? "sell" : "neutral";
  const reason =
    direction === "buy"
      ? `브라우저 실시간 계산: 상승 우위, RSI ${formatNumber(rsi)}, 거래량 ${formatNumber(volumeRatio)}x`
      : direction === "sell"
        ? `브라우저 실시간 계산: 하락 주의, RSI ${formatNumber(rsi)}, 거래량 ${formatNumber(volumeRatio)}x`
        : `브라우저 실시간 계산: 중립, RSI ${formatNumber(rsi)}, 거래량 ${formatNumber(volumeRatio)}x`;

  return {
    id: `live-${coin.binanceSymbol}-${timeframe}`,
    symbol: coin.binanceSymbol,
    asset: coin.symbol,
    coinName: coin.name,
    marketCapRank: coin.marketCapRank,
    timeframe,
    direction,
    score,
    reason,
    price,
    rsi,
    macd: null,
    macdSignal: null,
    ema50,
    ema200,
    volumeRatio,
    candles: closes.slice(-365),
    candleTimes: times.slice(-365),
    components: {
      sma20w: sma20w ?? 0,
      fibPosition: fibPosition ?? 0,
      fibNearest: fibNearest ?? 0,
      yearlyHigh,
      yearlyLow,
    },
    newsScore: 0,
    newsArticleCount: 0,
    createdAt: {
      seconds: Math.floor(Date.now() / 1000),
      nanoseconds: 0,
    },
  };
}

async function fetchBinanceTradingSymbols() {
  const response = await fetch("https://api.binance.com/api/v3/exchangeInfo");
  if (!response.ok) throw new Error(`Binance exchangeInfo failed: ${response.status}`);
  const data = (await response.json()) as {
    symbols: Array<{ symbol: string; quoteAsset: string; status: string; isSpotTradingAllowed: boolean }>;
  };

  return new Set(
    data.symbols
      .filter((symbol) => symbol.status === "TRADING" && symbol.quoteAsset === "USDT" && symbol.isSpotTradingAllowed)
      .map((symbol) => symbol.symbol),
  );
}

async function fetchTopMarketCapCoins() {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", "50");
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");

  const response = await fetch(url);
  if (!response.ok) throw new Error(`CoinGecko top 50 failed: ${response.status}`);
  const rows = (await response.json()) as Array<{
    id: string;
    name: string;
    symbol: string;
    market_cap_rank: number;
  }>;

  return rows
    .map((row) => {
      const symbol = row.symbol.toUpperCase();
      return {
        id: row.id,
        name: row.name,
        symbol,
        marketCapRank: row.market_cap_rank,
        binanceSymbol: `${symbol}USDT`,
      };
    })
    .filter((coin) => !EXCLUDED_ASSETS.has(coin.symbol));
}

async function fetchLiveSignal(coin: MarketCoin, timeframe = "1d") {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", coin.binanceSymbol);
  url.searchParams.set("interval", timeframe);
  url.searchParams.set("limit", "365");

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Binance request failed: ${response.status}`);
  const rows = (await response.json()) as Array<[number, string, string, string, string, string]>;
  const candles = rows.map((row) => ({
    openTime: Number(row[0]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  }));

  return buildLiveSignal(coin, timeframe, candles);
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
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

async function fetchLiveTopSignals() {
  const [coins, tradableSymbols] = await Promise.all([fetchTopMarketCapCoins(), fetchBinanceTradingSymbols()]);
  const universe = coins.filter((coin) => tradableSymbols.has(coin.binanceSymbol));
  const signals = await mapLimit(universe, 6, (coin) => fetchLiveSignal(coin));

  return signals
    .filter(Boolean)
    .sort((left, right) => (left.marketCapRank ?? 999) - (right.marketCapRank ?? 999));
}

function chartPath(values: number[], width: number, height: number, padding = 8) {
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

function monthMarkers(times: number[] | undefined, width: number, padding: number) {
  if (!times || times.length < 2) return [];
  const usableWidth = width - padding * 2;

  return times
    .map((time, index) => {
      const date = new Date(time);
      const previous = index > 0 ? new Date(times[index - 1]) : null;
      if (index === 0 || !previous || date.getMonth() === previous.getMonth()) return null;
      return {
        x: padding + (index / (times.length - 1)) * usableWidth,
        label: `${date.getMonth() + 1}월`,
      };
    })
    .filter((marker): marker is { x: number; label: string } => marker !== null);
}

function yearChange(values?: number[]) {
  const first = values?.[0] ?? null;
  const last = values?.[values.length - 1] ?? null;
  return first && last ? ((last - first) / first) * 100 : null;
}

function dayChange(values?: number[]) {
  if (!values || values.length < 2) return null;
  const last = values[values.length - 1];
  const previous = values[values.length - 2];
  return previous ? ((last - previous) / previous) * 100 : null;
}

function rangeDays(range: ChartRange) {
  return CHART_RANGES.find((item) => item.value === range)?.days ?? 365;
}

function sliceByRange<T>(values: T[] | undefined, range: ChartRange) {
  return values?.slice(-rangeDays(range));
}

function indicatorText(signal: SignalRecord) {
  const sma20w = signal.components?.sma20w ?? null;
  const fibNearest = signal.components?.fibNearest ?? null;
  const maState = sma20w && signal.price >= sma20w ? "20주선 위" : sma20w ? "20주선 아래" : "20주선 대기";
  const fibText = fibNearest !== null ? `피보 ${formatNumber(fibNearest, 1)}%` : "피보 대기";
  const volumeText = signal.volumeRatio !== null ? `거래량 평균의 ${formatNumber(signal.volumeRatio)}배` : "거래량 대기";
  const newsText =
    signal.newsArticleCount && signal.newsArticleCount > 0
      ? `뉴스 ${formatNumber(signal.newsScore ?? 0, 0)} / ${signal.newsArticleCount}건`
      : "뉴스 대기";
  return {
    maState,
    fibText,
    volumeText,
    newsText,
    rsiText: signal.rsi !== null ? `RSI ${formatNumber(signal.rsi)}` : "RSI 대기",
  };
}

function buyReason(signal: SignalRecord) {
  const sma20w = signal.components?.sma20w ?? null;
  const fibNearest = signal.components?.fibNearest ?? null;
  const reasons = [];

  if (sma20w) {
    reasons.push(signal.price >= sma20w ? `현재가가 20주 평균선(${formatNumber(sma20w, 4)} USDT) 위` : "현재가가 20주 평균선 아래");
  }

  if (signal.rsi !== null) {
    if (signal.rsi < 30) reasons.push(`RSI ${formatNumber(signal.rsi)} 과매도`);
    else if (signal.rsi < 70) reasons.push(`RSI ${formatNumber(signal.rsi)} 과열 전`);
    else reasons.push(`RSI ${formatNumber(signal.rsi)} 과열 주의`);
  }

  if (fibNearest !== null) {
    reasons.push(`1년 고저점 기준 피보나치 ${formatNumber(fibNearest, 1)}% 부근`);
  }

  if (signal.volumeRatio !== null) {
    reasons.push(`거래량은 최근 평균의 ${formatNumber(signal.volumeRatio)}배`);
  }

  return reasons.join(" · ");
}

function Sparkline({ values, times, large = false }: { values?: number[]; times?: number[]; large?: boolean }) {
  const width = large ? 960 : 280;
  const height = large ? 240 : 64;
  const padding = large ? 18 : 7;
  const path = chartPath(values ?? [], width, height, padding);
  const last = values?.[values.length - 1] ?? null;
  const change = yearChange(values);
  const color = change !== null && change >= 0 ? "#0f8b72" : "#df5b50";
  const markers = monthMarkers(times, width, padding);

  return (
    <div className={large ? "chartBox large" : "chartBox mini"}>
      {large && (
        <div className="chartHeader">
          <div>
            <strong>{last ? `${formatNumber(last, 4)} USDT` : "-"}</strong>
            <span>선택 기간 일봉 · 월 표시</span>
          </div>
          <b className={change !== null && change >= 0 ? "positive" : "negative"}>{formatPercent(change)}</b>
        </div>
      )}
      {path ? (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="가격 추세 그래프" preserveAspectRatio="none">
          <path className="chartGrid" d={`M 0 ${height - 1} L ${width} ${height - 1}`} />
          {markers.map((marker) => (
            <g key={`${marker.label}-${marker.x}`}>
              <path className="chartMonthLine" d={`M ${marker.x.toFixed(2)} 0 L ${marker.x.toFixed(2)} ${height}`} />
              {large && (
                <text className="chartMonthLabel" x={marker.x + 4} y={14}>
                  {marker.label}
                </text>
              )}
            </g>
          ))}
          <path d={path} fill="none" stroke={color} strokeWidth={large ? 3 : 2.1} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <div className="chartEmpty">차트 대기</div>
      )}
    </div>
  );
}

export default function App() {
  const [signals, setSignals] = useState<SignalRecord[]>([]);
  const [serverSignals, setServerSignals] = useState<SignalRecord[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [usdKrw, setUsdKrw] = useState<number | null>(null);
  const [activeView, setActiveView] = useState<"dashboard" | "markets" | "settings">("dashboard");
  const [coinInput, setCoinInput] = useState("");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [chartRange, setChartRange] = useState<ChartRange>("1y");
  const [watchSymbols, setWatchSymbols] = useState<string[]>(() => {
    try {
      const saved = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as string[]) : [];
    } catch {
      return [];
    }
  });
  const latest = useMemo(() => signals.find((signal) => signal.symbol === selectedSymbol) ?? signals[0], [selectedSymbol, signals]);
  const watchedSignalSymbols = useMemo(() => new Set(watchSymbols), [watchSymbols]);
  const signalSource = serverSignals.length ? serverSignals : signals;
  const watchedSignals = useMemo(
    () => signalSource.filter((signal) => watchedSignalSymbols.has(signal.symbol)),
    [signalSource, watchedSignalSymbols],
  );
  const buySignals = useMemo(() => watchedSignals.filter((signal) => signal.direction === "buy"), [watchedSignals]);
  const sellSignals = useMemo(() => watchedSignals.filter((signal) => signal.direction === "sell"), [watchedSignals]);

  useEffect(() => {
    if (!auth) return undefined;
    return onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (!user || !db) {
      window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchSymbols));
    }
  }, [user, watchSymbols]);

  useEffect(() => {
    if (!user || !db) return undefined;
    const watchlistRef = doc(db, "users", user.uid, "settings", "watchlist");

    return onSnapshot(watchlistRef, async (snapshot) => {
      const symbols = snapshot.exists() ? snapshot.data().symbols : null;
      if (Array.isArray(symbols)) {
        setWatchSymbols(symbols.filter((symbol): symbol is string => typeof symbol === "string"));
        return;
      }

      const saved = window.localStorage.getItem(WATCHLIST_STORAGE_KEY);
      const localSymbols = saved ? (JSON.parse(saved) as string[]) : [];
      if (localSymbols.length) {
        await setDoc(watchlistRef, {
          symbols: localSymbols,
          updatedAt: serverTimestamp(),
        });
      }
    });
  }, [user]);

  useEffect(() => {
    let active = true;

    async function loadExchangeRate() {
      try {
        const response = await fetch("https://open.er-api.com/v6/latest/USD");
        if (!response.ok) throw new Error(`exchange rate failed: ${response.status}`);
        const data = (await response.json()) as { rates?: { KRW?: number } };
        if (active && data.rates?.KRW) setUsdKrw(data.rates.KRW);
      } catch {
        if (active) setUsdKrw(null);
      }
    }

    loadExchangeRate();
    const timer = window.setInterval(loadExchangeRate, 30 * 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadLivePrices() {
      try {
        const liveSignals = await fetchLiveTopSignals();
        if (active) {
          setSignals(liveSignals);
          setLiveError(null);
        }
      } catch (error) {
        if (active) setLiveError(error instanceof Error ? error.message : "실시간 데이터를 불러오지 못했습니다.");
      }
    }

    loadLivePrices();
    const timer = window.setInterval(loadLivePrices, 60_000);
    const unsubscribe = db
      ? onSnapshot(collection(db, "signals"), (snapshot) => {
          const serverSignals = snapshot.docs
            .map((item) => ({
              id: item.id,
              ...(item.data() as Omit<SignalRecord, "id">),
            }))
            .filter((signal) => Array.isArray(signal.candles) && signal.candles.length > 1)
            .sort((left, right) => (left.marketCapRank ?? 999) - (right.marketCapRank ?? 999));

          if (active) setServerSignals(serverSignals);
        })
      : undefined;

    return () => {
      active = false;
      window.clearInterval(timer);
      unsubscribe?.();
    };
  }, []);

  async function handleGoogleLogin() {
    if (!auth) return;
    setAuthBusy(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    if (!auth) return;
    setAuthBusy(true);
    try {
      await signOut(auth);
    } finally {
      setAuthBusy(false);
    }
  }

  async function saveWatchSymbols(next: string[]) {
    setWatchSymbols(next);
    if (user && db) {
      await setDoc(doc(db, "users", user.uid, "settings", "watchlist"), {
        symbols: next,
        updatedAt: serverTimestamp(),
      });
    } else {
      window.localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
    }
  }

  function addWatchSymbol(value: string) {
    const symbol = normalizeWatchSymbol(value);
    if (!symbol) return;
    void saveWatchSymbols(watchSymbols.includes(symbol) ? watchSymbols : [...watchSymbols, symbol]);
    setCoinInput("");
  }

  function removeWatchSymbol(symbol: string) {
    void saveWatchSymbols(watchSymbols.filter((item) => item !== symbol));
    if (selectedSymbol === symbol) setSelectedSymbol(null);
  }

  const navButtons = (
    <>
      <button className={activeView === "dashboard" ? "active" : ""} type="button" title="대시보드" onClick={() => setActiveView("dashboard")}>
        <Activity size={18} />
        <span>대시보드</span>
      </button>
      <button className={activeView === "markets" ? "active" : ""} type="button" title="Top 50" onClick={() => setActiveView("markets")}>
        <Radio size={18} />
        <span>Top 50</span>
      </button>
      <button className={activeView === "settings" ? "active" : ""} type="button" title="설정" onClick={() => setActiveView("settings")}>
        <Settings size={18} />
        <span>설정</span>
      </button>
    </>
  );

  return (
    <main className="appShell">
      <header className="mobileHeader">
        <div className="brand">
          <CandlestickChart size={23} />
          <div>
            <strong>Coin Signal</strong>
            <span>Kakao alert bot</span>
          </div>
        </div>
        {user ? (
          <button className="mobileAvatar" type="button" onClick={handleLogout} disabled={authBusy} title="로그아웃">
            {user.photoURL ? <img src={user.photoURL} alt="" /> : <span>{user.displayName?.[0] ?? "U"}</span>}
          </button>
        ) : (
          <button className="mobileLogin" type="button" onClick={handleGoogleLogin} disabled={!auth || authBusy} title="Google 로그인">
            <LogIn size={17} />
          </button>
        )}
      </header>

      <aside className="sidebar">
        <div className="brand">
          <CandlestickChart size={24} />
          <div>
            <strong>Coin Signal</strong>
            <span>Kakao alert bot</span>
          </div>
        </div>

        <nav className="navList" aria-label="주요 메뉴">
          {navButtons}
        </nav>
      </aside>

      <section className="content">
        <div className="accountBar">
          {user ? (
            <div className="userMenu">
              {user.photoURL ? <img src={user.photoURL} alt="" /> : <span className="userInitial">{user.displayName?.[0] ?? "U"}</span>}
              <div>
                <strong>{user.displayName ?? "Google 사용자"}</strong>
                <span>{user.email}</span>
              </div>
              <button type="button" onClick={handleLogout} disabled={authBusy} title="로그아웃">
                <LogOut size={17} />
                <span>로그아웃</span>
              </button>
            </div>
          ) : (
            <button className="loginButton" type="button" onClick={handleGoogleLogin} disabled={!auth || authBusy} title="Google 로그인">
              <LogIn size={17} />
              <span>Google 로그인</span>
            </button>
          )}
        </div>

        <header className="topbar">
          <div>
            <h1>{activeView === "dashboard" ? "대시보드" : activeView === "markets" ? "시총 Top 50" : "관심 코인 설정"}</h1>
          </div>
          <div className="signalBadge neutral">
            <span>
              {activeView === "dashboard"
                ? `${buySignals.length + sellSignals.length}개`
                : activeView === "markets"
                  ? signals.length ? `${signals.length}개` : "로딩 중"
                  : `${watchSymbols.length}개`}
            </span>
          </div>
        </header>

        {activeView === "settings" ? (
          <section className="panel settingsPanel">
            <div className="panelHeader">
              <h2>관심 코인 설정</h2>
              <span>{watchSymbols.length}개</span>
            </div>
            <form
              className="coinForm"
              onSubmit={(event) => {
                event.preventDefault();
                addWatchSymbol(coinInput);
              }}
            >
              <input value={coinInput} onChange={(event) => setCoinInput(event.target.value)} placeholder="BTC, ETH, SOL" aria-label="관심 코인" />
              <button type="submit" title="관심 코인 추가">
                <Plus size={17} />
                <span>추가</span>
              </button>
            </form>
            <div className="coinChipList">
              {watchSymbols.length === 0 ? (
              <p className="helperText">관심 코인을 추가하면 설정에 저장됩니다.</p>
              ) : (
                watchSymbols.map((symbol) => (
                  <span className="coinChip" key={symbol}>
                    {displaySymbol(symbol)}
                    <button type="button" onClick={() => removeWatchSymbol(symbol)} title={`${displaySymbol(symbol)} 삭제`}>
                      <Trash2 size={14} />
                    </button>
                  </span>
                ))
              )}
            </div>
            <div className="suggestions">
              <strong>Top 50에서 빠르게 추가</strong>
              <div>
                {signals.slice(0, 12).map((signal) => (
                  <button type="button" key={signal.symbol} onClick={() => addWatchSymbol(signal.symbol)}>
                    {displaySymbol(signal.symbol)}
                  </button>
                ))}
              </div>
            </div>
          </section>
        ) : (
          <>
            {activeView === "dashboard" && (
              <>
                <section className="panel watchPanel">
                  <div className="panelHeader">
                    <h2>관심 코인</h2>
                    <span>{watchSymbols.length}개</span>
                  </div>
                  <div className="watchQuickList">
                    {watchSymbols.length === 0 ? (
                      <p>설정에서 BTC, ETH, SOL처럼 관심 코인을 추가하세요.</p>
                    ) : (
                      watchSymbols.map((symbol) => (
                        <button
                          className={latest?.symbol === symbol ? "active" : ""}
                          key={symbol}
                          type="button"
                          onClick={() => setSelectedSymbol(symbol)}
                        >
                          {displaySymbol(symbol)}
                        </button>
                      ))
                    )}
                  </div>
                </section>

                <section className="panel buyPanel" aria-label="매수 신호 코인">
                  <div className="panelHeader">
                    <h2>매수 신호</h2>
                    <span>{buySignals.length}개</span>
                  </div>
                  {buySignals.length === 0 ? (
                    <div className="emptyState">
                      <p>{watchSymbols.length ? "관심 코인 중 현재 조건에 맞는 매수 신호가 없습니다." : "설정에서 관심 코인을 먼저 추가하세요."}</p>
                    </div>
                  ) : (
                    <div className="buySignalList">
                      {buySignals.map((signal) => (
                        <button className="buySignalCard" key={signal.id} type="button" onClick={() => setSelectedSymbol(signal.symbol)}>
                          <div>
                            <span>#{signal.marketCapRank ?? "-"}</span>
                            <strong>{displaySymbol(signal.symbol)}</strong>
                            <small>{signal.coinName ?? signal.asset}</small>
                          </div>
                          <strong className="priceStack">
                            <span>{formatNumber(signal.price, 4)} USDT</span>
                            <small>{usdKrw ? formatKrw(signal.price * usdKrw) : "환율 대기"}</small>
                          </strong>
                          <span>{indicatorText(signal).rsiText}</span>
                          <span>{indicatorText(signal).maState}</span>
                          <span>{indicatorText(signal).fibText}</span>
                          <span>{indicatorText(signal).volumeText}</span>
                          <span>{indicatorText(signal).newsText}</span>
                          <p>{buyReason(signal)}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                <section className="panel sellPanel" aria-label="하락 위험 코인">
                  <div className="panelHeader">
                    <h2>하락 위험</h2>
                    <span>{sellSignals.length}개</span>
                  </div>
                  {sellSignals.length === 0 ? (
                    <div className="emptyState">
                      <p>{watchSymbols.length ? "관심 코인 중 현재 강한 하락 위험 신호가 없습니다." : "설정에서 관심 코인을 먼저 추가하세요."}</p>
                    </div>
                  ) : (
                    <div className="buySignalList">
                      {sellSignals.map((signal) => (
                        <button className="buySignalCard sellSignalCard" key={signal.id} type="button" onClick={() => setSelectedSymbol(signal.symbol)}>
                          <div>
                            <span>#{signal.marketCapRank ?? "-"}</span>
                            <strong>{displaySymbol(signal.symbol)}</strong>
                            <small>{signal.coinName ?? signal.asset}</small>
                          </div>
                          <strong className="priceStack">
                            <span>{formatNumber(signal.price, 4)} USDT</span>
                            <small>{usdKrw ? formatKrw(signal.price * usdKrw) : "환율 대기"}</small>
                          </strong>
                          <span>{indicatorText(signal).rsiText}</span>
                          <span>{indicatorText(signal).maState}</span>
                          <span>{indicatorText(signal).fibText}</span>
                          <span>{indicatorText(signal).volumeText}</span>
                          <span>{indicatorText(signal).newsText}</span>
                          <p>{signal.reason}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}

            {activeView === "markets" && (
              <>
                <section className="panel marketPanel">
                  <div className="panelHeader">
                    <h2>시총 Top 50</h2>
                    <div className="rangeControls" aria-label="그래프 기간">
                      {CHART_RANGES.map((range) => (
                        <button className={chartRange === range.value ? "active" : ""} key={range.value} type="button" onClick={() => setChartRange(range.value)}>
                          {range.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {signals.length === 0 ? (
                    <div className="emptyState">
                      <p>{liveError ? `Binance 실시간 데이터 오류: ${liveError}` : "Binance 가격 데이터를 불러오는 중입니다."}</p>
                    </div>
                  ) : (
                    <div className="marketList">
                      {signals.map((signal) => (
                      <button
                        className={`marketRow ${watchedSignalSymbols.has(signal.symbol) && signal.direction === "buy" ? "buySignal" : ""} ${latest?.symbol === signal.symbol ? "active" : ""}`}
                        key={signal.id}
                        type="button"
                        onClick={() => setSelectedSymbol(signal.symbol)}
                      >
                        <div className="marketAsset">
                          <span>#{signal.marketCapRank ?? "-"}</span>
                          <strong>{displaySymbol(signal.symbol)}</strong>
                          <small>{signal.coinName ?? signal.asset}{watchSymbols.includes(signal.symbol) ? " · 관심" : ""}</small>
                        </div>
                        <strong className="marketPrice priceStack">
                          <span>{formatNumber(signal.price, 4)} USDT</span>
                          <small>{usdKrw ? formatKrw(signal.price * usdKrw) : "환율 대기"}</small>
                        </strong>
                        <span className={dayChange(signal.candles) !== null && dayChange(signal.candles)! >= 0 ? "marketChange positiveText" : "marketChange negativeText"}>
                          {formatPercent(dayChange(signal.candles))}
                        </span>
                        <div className="marketIndicators">
                          <span>{indicatorText(signal).rsiText}</span>
                          <span>{indicatorText(signal).maState}</span>
                          <span>{indicatorText(signal).fibText}</span>
                          <span>{indicatorText(signal).volumeText}</span>
                          <span>{indicatorText(signal).newsText}</span>
                        </div>
                        <Sparkline values={sliceByRange(signal.candles, chartRange)} times={sliceByRange(signal.candleTimes, chartRange)} />
                      </button>
                      ))}
                    </div>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </section>

      <nav className="mobileNav" aria-label="모바일 주요 메뉴">
        {navButtons}
      </nav>
    </main>
  );
}
