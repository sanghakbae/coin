import { useEffect, useMemo, useState } from "react";
import { Activity, Bell, CandlestickChart, CircleAlert, LogIn, LogOut, Radio, Settings } from "lucide-react";
import { GoogleAuthProvider, User, onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { auth, db, hasFirebaseConfig } from "./firebase";
import type { SignalRecord, WatchItem } from "./types";

const demoWatchlist: WatchItem[] = [
  {
    id: "btcusdt",
    symbol: "BTCUSDT",
    timeframe: "15m / 1h / 4h",
    enabled: true,
    exchange: "binance",
    rsiBuy: 30,
    rsiSell: 70,
    volumeSpike: 1.8,
  },
];

interface BinanceCandle {
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

function formatTime(signal: SignalRecord) {
  if (!signal.createdAt) return "대기 중";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(signal.createdAt.seconds * 1000));
}

function formatNumber(value: number | null, digits = 2) {
  if (value === null || Number.isNaN(value)) return "-";
  return value.toLocaleString("ko-KR", { maximumFractionDigits: digits });
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
  const volumes = candles.map((candle) => candle.volume);
  const price = closes[closes.length - 1] ?? 0;
  const previous = closes[closes.length - 2] ?? price;
  const rsi = calculateRsi(closes);
  const ema50 = calculateEma(closes, 50);
  const ema200 = calculateEma(closes, 200);
  const recentAverageVolume = average(volumes.slice(-21, -1));
  const volumeRatio = recentAverageVolume > 0 ? (volumes[volumes.length - 1] ?? 0) / recentAverageVolume : null;
  const trendScore = ema50 !== null && ema200 !== null ? (price > ema50 && ema50 > ema200 ? 18 : price < ema50 && ema50 < ema200 ? -18 : 0) : 0;
  const rsiScore = rsi === null ? 0 : rsi <= 30 ? 14 : rsi >= 70 ? -14 : rsi > 50 ? 6 : -6;
  const volumeScore = volumeRatio !== null && volumeRatio >= 1.5 ? (price >= previous ? 8 : -8) : 0;
  const score = Math.round(trendScore + rsiScore + volumeScore);
  const direction = score >= 22 ? "buy" : score <= -22 ? "sell" : "neutral";
  const reason =
    direction === "buy"
      ? `브라우저 실시간 계산: 상승 우위, RSI ${formatNumber(rsi)}, 거래량 ${formatNumber(volumeRatio)}x`
      : direction === "sell"
        ? `브라우저 실시간 계산: 하락 경계, RSI ${formatNumber(rsi)}, 거래량 ${formatNumber(volumeRatio)}x`
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

async function fetchLiveSignal(coin: MarketCoin, timeframe = "1h") {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", coin.binanceSymbol);
  url.searchParams.set("interval", timeframe);
  url.searchParams.set("limit", "220");

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Binance request failed: ${response.status}`);
  const rows = (await response.json()) as Array<[number, string, string, string, string, string]>;
  const candles = rows.map((row) => ({
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
    .sort((left, right) => Math.abs(right.score ?? 0) - Math.abs(left.score ?? 0));
}

export default function App() {
  const [signals, setSignals] = useState<SignalRecord[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const latest = signals[0];
  const watchlist = useMemo<WatchItem[]>(
    () =>
      signals.length
        ? signals.slice(0, 5).map((signal) => ({
            id: signal.symbol,
            symbol: signal.symbol,
            timeframe: signal.timeframe,
            enabled: true,
            exchange: "binance",
            rsiBuy: 30,
            rsiSell: 70,
            volumeSpike: 1.8,
          }))
        : demoWatchlist,
    [signals],
  );

  useEffect(() => {
    if (!auth) return undefined;
    return onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    let hasFirestoreSignals = false;
    let active = true;

    async function loadLiveFallback() {
      try {
        const liveSignals = await fetchLiveTopSignals();
        if (active && !hasFirestoreSignals) {
          setSignals(liveSignals);
          setLiveError(null);
        }
      } catch (error) {
        if (active) setLiveError(error instanceof Error ? error.message : "실시간 데이터를 불러오지 못했습니다.");
      }
    }

    loadLiveFallback();
    const timer = window.setInterval(loadLiveFallback, 60_000);

    if (!db) {
      return () => {
        active = false;
        window.clearInterval(timer);
      };
    }

    const signalQuery = query(collection(db, "signals"), orderBy("createdAt", "desc"), limit(20));
    const unsubscribe = onSnapshot(
      signalQuery,
      (snapshot) => {
        hasFirestoreSignals = snapshot.docs.length > 0;
        if (hasFirestoreSignals) {
          setSignals(
            snapshot.docs.map((doc) => ({
              id: doc.id,
              ...(doc.data() as Omit<SignalRecord, "id">),
            })),
          );
        }
      },
      () => {
        hasFirestoreSignals = false;
        loadLiveFallback();
      },
    );

    return () => {
      active = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const status = useMemo(() => {
    if (!latest) return { label: "신호 대기", className: "neutral" };
    if (latest.direction === "buy") return { label: "매수 관심", className: "buy" };
    if (latest.direction === "sell") return { label: "매도 경계", className: "sell" };
    return { label: "중립", className: "neutral" };
  }, [latest]);

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
          <button className="active" type="button" title="실시간 신호">
            <Radio size={18} />
            <span>실시간 신호</span>
          </button>
          <button type="button" title="알림 내역">
            <Bell size={18} />
            <span>알림 내역</span>
          </button>
          <button type="button" title="설정">
            <Settings size={18} />
            <span>설정</span>
          </button>
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
            <h1>암호화폐 매매 신호</h1>
            <p>시총 상위 50개 중 Binance USDT 현물 거래쌍을 스캔하고, 지표와 뉴스 점수를 합산해 카카오톡 알림을 보냅니다.</p>
          </div>
          <div className={`signalBadge ${status.className}`}>
            <Activity size={18} />
            <span>{status.label}</span>
          </div>
        </header>

        <section className="metricGrid" aria-label="최신 지표">
          <article className="metric">
            <span>가격</span>
            <strong>{latest ? `${formatNumber(latest.price, 4)} USDT` : "-"}</strong>
          </article>
          <article className="metric">
            <span>RSI</span>
            <strong>{latest ? formatNumber(latest.rsi) : "-"}</strong>
          </article>
          <article className="metric">
            <span>점수</span>
            <strong>{latest ? formatNumber(latest.score ?? 0, 0) : "-"}</strong>
          </article>
          <article className="metric">
            <span>뉴스</span>
            <strong>{latest ? `${formatNumber(latest.newsScore ?? 0, 0)} / ${latest.newsArticleCount ?? 0}건` : "-"}</strong>
          </article>
        </section>

        <section className="workspace">
          <div className="panel">
            <div className="panelHeader">
              <h2>관심 코인</h2>
              <span>{watchlist.length}개</span>
            </div>
            <div className="watchList">
              {watchlist.map((item) => (
                <article className="watchItem" key={item.id}>
                  <div>
                    <strong>{item.symbol}</strong>
                    <span>{item.exchange.toUpperCase()} · {item.timeframe}</span>
                  </div>
                  <dl>
                    <div>
                      <dt>RSI 매수</dt>
                      <dd>{item.rsiBuy}</dd>
                    </div>
                    <div>
                      <dt>RSI 매도</dt>
                      <dd>{item.rsiSell}</dd>
                    </div>
                    <div>
                      <dt>거래량</dt>
                      <dd>{item.volumeSpike}x</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panelHeader">
              <h2>최근 신호</h2>
              <span>{signals.length}건</span>
            </div>

            {signals.length === 0 ? (
              <div className="emptyState">
                <CircleAlert size={22} />
                <p>
                  {liveError
                    ? `Binance 실시간 데이터 오류: ${liveError}`
                    : hasFirebaseConfig
                      ? "Binance 실시간 데이터를 불러오는 중입니다."
                      : ".env.local에 Firebase 웹앱 설정을 입력하면 Firestore 신호를 구독합니다."}
                </p>
              </div>
            ) : (
              <div className="signalList">
                {signals.map((signal) => (
                  <article className={`signalRow ${signal.direction}`} key={signal.id}>
                    <div>
                      <strong>{signal.symbol} {signal.score !== undefined ? `· ${signal.score}` : ""}</strong>
                      <span>{signal.reason}</span>
                    </div>
                    <div className="signalMeta">
                      <span>{signal.timeframe}</span>
                      <time>{formatTime(signal)}</time>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </section>

      <nav className="mobileNav" aria-label="모바일 주요 메뉴">
        <button className="active" type="button" title="실시간 신호">
          <Radio size={20} />
          <span>신호</span>
        </button>
        <button type="button" title="알림 내역">
          <Bell size={20} />
          <span>알림</span>
        </button>
        <button type="button" title="설정">
          <Settings size={20} />
          <span>설정</span>
        </button>
      </nav>
    </main>
  );
}
