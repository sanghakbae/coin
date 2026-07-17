import { createRequire } from "node:module";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

const CANDLE_LIMIT = 365;
const BUY_THRESHOLD = 35;
const SELL_THRESHOLD = -35;
const PUMP_ALERT_THRESHOLD = 10;
const SITE_URL = process.env.SITE_URL || "https://dot.sanghak.kr";
const BINANCE_API_BASES = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];
const EXCLUDED_ASSETS = new Set([
  "USDT",
  "USDC",
  "USDS",
  "RLUSD",
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
  assertEnv("KAKAO_REST_API_KEY");
  assertEnv("KAKAO_REFRESH_TOKEN");

  if (process.env.KAKAO_TEST_MESSAGE === "true") {
    await sendKakaoTestMemo();
    console.log("Kakao test message sent successfully.");
    return;
  }

  assertEnv("FIREBASE_SERVICE_ACCOUNT_COIN_F1318");

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_COIN_F1318);
  if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });

  const db = getFirestore();
  await syncEcosystemProjects(db).catch((error) => console.warn(`ecosystem snapshot skipped: ${error.message}`));
  const dot = { id: "polkadot", name: "Polkadot", symbol: "DOT", marketCapRank: null, binanceSymbol: "DOTUSDT" };
  const [candles, ticker24h, context] = await Promise.all([
    fetchBinanceCandles(dot.binanceSymbol, "1d", CANDLE_LIMIT),
    fetchBinanceTicker24h(dot.binanceSymbol),
    fetchDotContext(),
  ]);
  const signals = [calculateSignal(dot, "1d", candles, ticker24h, context)];

  await saveSignals(db, signals);

  for (const signal of signals) {
    const previous = await readPreviousState(db, signal);
    const hasPreviousState = previous !== null;
    const enteredSignal = hasPreviousState && signal.direction !== "neutral" && previous.direction !== signal.direction;
    const crossedPositive = hasPreviousState && previous.score <= 0 && signal.score > 0;
    const crossedPump = hasPreviousState && previous.dayChangePercent < PUMP_ALERT_THRESHOLD && (signal.dayChangePercent ?? 0) >= PUMP_ALERT_THRESHOLD;

    if (enteredSignal) {
      await sendKakaoMemo(signal);
    } else if (crossedPositive) {
      await sendKakaoMemo(signal, "positive", previous.score);
    } else if (crossedPump) {
      await sendKakaoMemo(signal, "pump");
    }
    await updateCurrentState(db, signal);
  }
}

async function readPreviousState(db, signal) {
  const snapshot = await db.collection("state").doc(`${signal.symbol}_${signal.timeframe}`).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  const score = Number(data?.currentScore);
  const dayChangePercent = Number(data?.currentDayChangePercent);
  if (!Number.isFinite(score)) return null;
  return {
    score,
    direction: typeof data?.currentDirection === "string" ? data.currentDirection : "neutral",
    dayChangePercent: Number.isFinite(dayChangePercent) ? dayChangePercent : 0,
  };
}

async function syncEcosystemProjects(db) {
  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("category", "dot-ecosystem");
  url.searchParams.set("order", "market_cap_desc");
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", "1");
  url.searchParams.set("sparkline", "false");
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`CoinGecko ecosystem failed: ${response.status}`);
  const rows = (await response.json()).filter((coin) => coin.id !== "polkadot" && !isExcludedMarketCoin({ symbol: String(coin.symbol).toUpperCase(), name: coin.name }));
  const collectionRef = db.collection("ecosystemProjects");
  const existing = await collectionRef.get();
  const knownIds = new Set(existing.docs.map((document) => document.id));
  const isInitialBaseline = existing.empty;
  const batch = db.batch();

  for (const coin of rows) {
    const isNew = !knownIds.has(coin.id);
    batch.set(
      collectionRef.doc(coin.id),
      {
        name: coin.name,
        symbol: String(coin.symbol).toUpperCase(),
        image: coin.image || "",
        price: coin.current_price ?? null,
        marketCap: coin.market_cap ?? null,
        change24h: coin.price_change_percentage_24h ?? null,
        active: true,
        updatedAt: FieldValue.serverTimestamp(),
        ...(isNew ? { firstSeen: FieldValue.serverTimestamp(), isBaseline: isInitialBaseline } : {}),
      },
      { merge: true },
    );
  }
  await batch.commit();
  console.log(`ecosystemProjects=${rows.length}, baseline=${isInitialBaseline}`);
}

function assertEnv(key) {
  if (!process.env[key]) throw new Error(`Missing required env: ${key}`);
}

function isExcludedMarketCoin(coin) {
  if (EXCLUDED_ASSETS.has(coin.symbol)) return true;
  return /\b(stablecoin|usd|dollar)\b/i.test(coin.name);
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

async function fetchBinanceTicker24h(symbol) {
  const row = await fetchBinanceJson(`/api/v3/ticker/24hr?symbol=${symbol}`);
  return {
    price: Number(row.lastPrice),
    changePercent: Number(row.priceChangePercent),
  };
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

async function fetchDotContext() {
  const repos = ["paritytech/polkadot-sdk", "polkadot-fellows/runtimes", "w3f/polkadot-spec"];
  const [newsResult, repoResults] = await Promise.all([
    fetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN", { headers: { accept: "application/json" } })
      .then(async (response) => (response.ok ? response.json() : { Data: [] }))
      .catch(() => ({ Data: [] })),
    Promise.all(repos.map(async (repo) => {
      const [commits, releases] = await Promise.all([
        fetch(`https://api.github.com/repos/${repo}/commits?per_page=4`, { headers: { accept: "application/vnd.github+json" } })
          .then(async (response) => (response.ok ? response.json() : []))
          .catch(() => []),
        fetch(`https://api.github.com/repos/${repo}/releases?per_page=1`, { headers: { accept: "application/vnd.github+json" } })
          .then(async (response) => (response.ok ? response.json() : []))
          .catch(() => []),
      ]);
      return { repo, commits, releases };
    })),
  ]);

  const articles = (newsResult.Data || []).filter((item) =>
    /polkadot|\bdot\b|parity|web3 foundation/i.test(`${item.title || ""} ${item.body || ""}`),
  );
  const newsScoreRaw = articles.slice(0, 8).reduce((sum, item) => sum + scoreNewsText(`${item.title || ""} ${item.body || ""}`), 0);
  const newsScore = newsScoreRaw >= 2 ? Math.min(12, 4 + newsScoreRaw * 2) : newsScoreRaw <= -2 ? -Math.min(12, 4 + Math.abs(newsScoreRaw) * 2) : 0;
  const activeRepoCount = repoResults.filter(({ commits }) => {
    const now = Date.now();
    const rows = commits;
    const date = rows[0]?.commit?.author?.date;
    return date && now - new Date(date).getTime() <= 30 * 86_400_000;
  }).length;
  const developmentIndex = calculateDevelopmentIndex(repoResults, repos.length);
  const devScore = developmentScore(developmentIndex);

  return { articleCount: articles.length, newsScore, activeRepoCount, developmentIndex, devScore };
}

function calculateDevelopmentIndex(repoResults, repoCount) {
  const now = Date.now();
  const commits = repoResults.flatMap(({ repo, commits: rows }) => rows.map((item) => ({ repo, date: item.commit?.author?.date })));
  const releases = repoResults.flatMap(({ releases: rows }) => rows.map((item) => item.published_at));
  const commits30d = commits.filter((item) => item.date && now - new Date(item.date).getTime() <= 30 * 86_400_000);
  const activeRepos = new Set(commits30d.map((item) => item.repo)).size;
  const latestCommitAt = commits.reduce((latest, item) => Math.max(latest, item.date ? new Date(item.date).getTime() : 0), 0);
  const latestCommitDays = latestCommitAt ? (now - latestCommitAt) / 86_400_000 : Number.POSITIVE_INFINITY;
  const recencyScore = latestCommitDays <= 2 ? 40 : latestCommitDays <= 7 ? 34 : latestCommitDays <= 14 ? 26 : latestCommitDays <= 30 ? 16 : latestCommitDays <= 60 ? 8 : 0;
  const breadthScore = Math.min(25, (activeRepos / repoCount) * 25);
  const cadenceScore = Math.min(20, (commits30d.length / (repoCount * 4)) * 20);
  const latestReleaseAt = releases.reduce((latest, date) => Math.max(latest, date ? new Date(date).getTime() : 0), 0);
  const latestReleaseDays = latestReleaseAt ? (now - latestReleaseAt) / 86_400_000 : Number.POSITIVE_INFINITY;
  const releaseScore = latestReleaseDays <= 90 ? 15 : latestReleaseDays <= 180 ? 8 : 0;
  return Math.round(Math.min(100, recencyScore + breadthScore + cadenceScore + releaseScore));
}

function developmentScore(index) {
  if (index >= 80) return 12;
  if (index >= 65) return 8;
  if (index >= 50) return 3;
  if (index >= 35) return -3;
  if (index >= 20) return -8;
  return -12;
}

function scoreNewsText(text) {
  const positive = ["adoption", "approve", "approved", "breakthrough", "growth", "launch", "milestone", "partnership", "release", "upgrade"];
  const negative = ["attack", "delay", "exploit", "hack", "lawsuit", "outage", "reject", "risk", "scam", "vulnerability"];
  const normalized = text.toLowerCase();
  const positiveHits = positive.filter((word) => normalized.includes(word)).length;
  const negativeHits = negative.filter((word) => normalized.includes(word)).length;
  return Math.max(-3, Math.min(3, positiveHits - negativeHits));
}

function calculateSignal(coin, timeframe, candles, ticker24h, context) {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const candlePrice = closes.at(-1) ?? 0;
  const price = Number.isFinite(ticker24h.price) ? ticker24h.price : candlePrice;
  const previous = closes.at(-2) ?? candlePrice;
  const rsi = calculateRsi(closes);
  const ema50 = calculateEma(closes, 50);
  const ema200 = calculateEma(closes, 200);
  const volumeRatio = ratioToAverage(volumes.at(-1) ?? 0, volumes.slice(-21, -1));
  const dayChangePercent = Number.isFinite(ticker24h.changePercent) ? ticker24h.changePercent : null;
  const trend = ema50 !== null && ema200 !== null ? (price > ema50 && ema50 > ema200 ? 18 : price < ema50 && ema50 < ema200 ? -18 : 0) : 0;
  const rsiScore = rsi === null ? 0 : rsi <= 30 ? 14 : rsi >= 70 ? -14 : rsi > 50 ? 6 : -6;
  const volume = volumeRatio !== null && volumeRatio >= 1.5 ? (price >= previous ? 8 : -8) : 0;
  const pump = dayChangePercent !== null && dayChangePercent >= PUMP_ALERT_THRESHOLD ? 12 : 0;
  const score = Math.round(trend + rsiScore + volume + pump + context.newsScore + context.devScore);
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
    reason: explainSignal(direction, {
      trend,
      rsi: rsiScore,
      volume,
      pump,
      news: context.newsScore,
      development: context.devScore,
    }),
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
    newsScore: context.newsScore,
    newsArticleCount: context.articleCount,
    activeDevRepos: context.activeRepoCount,
    developmentIndex: context.developmentIndex,
    components: { trend, rsi: rsiScore, volume, pump, news: context.newsScore, development: context.devScore },
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

async function updateCurrentState(db, signal) {
  await db
    .collection("state")
    .doc(`${signal.symbol}_${signal.timeframe}`)
    .set(
      {
        currentDirection: signal.direction,
        currentScore: signal.score,
        currentPrice: signal.price,
        currentDayChangePercent: signal.dayChangePercent,
        currentReason: signal.reason,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

async function sendKakaoMemo(signal, alertType = "signal", previousScore = null) {
  const accessToken = await refreshKakaoAccessToken();
  const asset = signal.symbol.endsWith("USDT") ? signal.symbol.slice(0, -4) : signal.symbol;
  const label = alertType === "positive" ? "종합점수 플러스 전환" : alertType === "pump" ? "10% 이상 상승" : signal.direction === "buy" ? "매수 신호" : "매도 신호";
  const detail = alertType === "positive"
    ? `이전 점수 ${previousScore} → 현재 점수 ${signal.score}\n${signal.reason}`
    : alertType === "pump"
      ? `24시간 상승률: ${round(signal.dayChangePercent)}%`
      : signal.reason;
  const message = `[${label}] ${asset} ${signal.timeframe}
점수: ${signal.score}
가격: ${signal.price.toLocaleString("ko-KR", { maximumFractionDigits: 6 })} USDT
시총 순위: ${signal.marketCapRank ? `#${signal.marketCapRank}` : "대시보드 확인"}
개발 지수: ${signal.developmentIndex}/100
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

async function sendKakaoTestMemo() {
  const accessToken = await refreshKakaoAccessToken();
  const sentAt = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Seoul",
  }).format(new Date());
  const response = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body: new URLSearchParams({
      template_object: JSON.stringify({
        object_type: "text",
        text: `[연결 테스트] DOT 알림\n카카오톡 알림 연결이 정상입니다.\n전송 시각: ${sentAt}`,
        link: { web_url: SITE_URL, mobile_web_url: SITE_URL },
      }),
    }),
  });
  if (!response.ok) throw new Error(`Kakao test send failed: ${response.status} ${await response.text()}`);
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
  const labels = {
    trend: "장기 추세",
    rsi: "RSI",
    volume: "거래량",
    pump: "24시간 급등",
    news: "뉴스",
    development: "개발 활동",
  };
  const base = Object.entries(components)
    .filter(([, value]) => value !== 0)
    .sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))
    .map(([key, value]) => `${labels[key] ?? key} ${value > 0 ? "+" : ""}${value}`)
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
