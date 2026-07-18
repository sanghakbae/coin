import { createRequire } from "node:module";
import { evaluateDotSignal } from "../src/signal-model.mjs";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const xxhash = require("xxhash-wasm");
const ASSETS_BY_KEY = require("../src/assets.json");

const CANDLE_LIMIT = 365;
const PUMP_ALERT_THRESHOLD = 10;
const SITE_URL = process.env.SITE_URL || "https://dot.sanghak.kr";
const BINANCE_API_BASES = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];
const POLKADOT_RELAY_RPC_ENDPOINTS = ["https://rpc.polkadot.io", "https://polkadot-rpc.publicnode.com"];
const POLKADOT_ASSET_HUB_RPC_ENDPOINTS = ["https://polkadot-asset-hub-rpc.polkadot.io", "https://asset-hub.polkadot.rpc.deserve.network"];
const rpcPreferredEndpoint = new Map();
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
const ASSETS = Object.values(ASSETS_BY_KEY);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const dryRun = process.env.DRY_RUN === "true";

  if (process.env.KAKAO_TEST_MESSAGE === "true") {
    assertEnv("KAKAO_REST_API_KEY");
    assertEnv("KAKAO_REFRESH_TOKEN");
    await sendKakaoTestMemo();
    console.log("Kakao test message sent successfully.");
    return;
  }

  let db = null;
  if (!dryRun) {
    assertEnv("KAKAO_REST_API_KEY");
    assertEnv("KAKAO_REFRESH_TOKEN");
    assertEnv("FIREBASE_SERVICE_ACCOUNT_COIN_F1318");
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_COIN_F1318);
    if (!getApps().length) initializeApp({ credential: cert(serviceAccount) });
    db = getFirestore();
    await syncEcosystemProjects(db).catch((error) => console.warn(`ecosystem snapshot skipped: ${error.message}`));
  }
  const watchlist = parseWatchlist();
  let assets = ASSETS.filter((asset) => watchlist.has(asset.binanceSymbol));
  if (!assets.length) {
    console.warn(`No configured assets match WATCHLIST_SYMBOLS: ${[...watchlist].join(", ")}. Falling back to all configured assets.`);
    assets = ASSETS;
  }
  const signals = await Promise.all(assets.map((asset) => calculateAssetSignal(asset)));

  if (dryRun) {
    console.log(JSON.stringify(signals.map((signal) => ({
      asset: signal.asset,
      symbol: signal.symbol,
      direction: signal.direction,
      score: signal.score,
      confidence: signal.confidence,
      riskLevel: signal.riskLevel,
      components: signal.components,
      developmentIndex: signal.developmentIndex,
      networkHealthy: signal.onchain?.networkHealthy ?? null,
      derivatives: signal.derivatives,
      onchain: signal.onchain,
      etf: signal.etf ? {
        aum: signal.etf.aum ?? null,
        sharesChange5d: signal.etf.sharesChange5d ?? null,
        premiumDiscount: signal.etf.premiumDiscount ?? null,
      } : null,
    })), null, 2));
    return;
  }

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

function optionalDataUnavailable(name, error) {
  console.warn(`${name} unavailable: ${error instanceof Error ? error.message : String(error)}`);
  return null;
}

function parseWatchlist() {
  const raw = process.env.WATCHLIST_SYMBOLS?.trim();
  const symbols = raw
    ? raw
      .split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean)
      .map((symbol) => (symbol.endsWith("USDT") ? symbol : `${symbol}USDT`))
    : ASSETS.map((asset) => asset.binanceSymbol);
  return new Set(symbols);
}

async function calculateAssetSignal(asset) {
  const [candles, ticker24h, context, macro, derivatives, onchain, etf] = await Promise.all([
    fetchBinanceCandles(asset.binanceSymbol, "1d", CANDLE_LIMIT),
    fetchBinanceTicker24h(asset.binanceSymbol),
    fetchAssetContext(asset),
    fetchMacroInfo(asset.btcSymbol),
    fetchDerivativesInfo(asset.binanceSymbol).catch((error) => optionalDataUnavailable(`${asset.symbol} derivatives`, error)),
    asset.networkAdapter === "polkadot" ? fetchOnchainInfo().catch((error) => optionalDataUnavailable("onchain", error)) : Promise.resolve(null),
    asset.networkAdapter === "polkadot" ? fetchEtfInfo().catch((error) => optionalDataUnavailable("etf", error)) : Promise.resolve(null),
  ]);
  return calculateSignal(asset, "1d", candles, ticker24h, context, macro, derivatives, onchain, etf);
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
  const assets = ASSETS.filter((asset) => asset.ecosystemCategory);
  for (const asset of assets) {
    const rows = await fetchEcosystemMarketRows(asset);
    const collectionRef = db.collection("ecosystemProjects").doc(asset.symbol).collection("projects");
    const existing = await collectionRef.get();
    const knownIds = new Set(existing.docs.map((document) => document.id));
    const isInitialBaseline = existing.empty;
    const batch = db.batch();

    for (const coin of rows) {
      const isNew = !knownIds.has(coin.id);
      batch.set(
        collectionRef.doc(coin.id),
        {
          assetSymbol: asset.symbol,
          category: asset.ecosystemCategory,
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
    console.log(`${asset.symbol} ecosystemProjects=${rows.length}, baseline=${isInitialBaseline}`);
  }
}

async function fetchEcosystemMarketRows(asset) {
  const categories = [asset.ecosystemCategory, ...(asset.ecosystemFallbackCategories || [])].filter(Boolean);
  const failures = [];
  for (const category of categories) {
    const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("category", category);
    url.searchParams.set("order", "market_cap_desc");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", "1");
    url.searchParams.set("sparkline", "false");
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      failures.push(`${category}: ${response.status}`);
      continue;
    }
    const rows = (await response.json()).filter((coin) =>
      coin.id !== asset.coinId && !isExcludedMarketCoin({ symbol: String(coin.symbol).toUpperCase(), name: coin.name }),
    );
    if (rows.length) return rows;
    failures.push(`${category}: empty`);
  }
  throw new Error(`CoinGecko ${asset.symbol} ecosystem failed: ${failures.join(", ") || "empty"}`);
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
    try {
      const response = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
      if (response.ok) return await readJsonResponse(response, base);
      errors.push(`${base} ${response.status}`);
    } catch (error) {
      errors.push(`${base} ${error.message}`);
    }
  }
  throw new Error(`Binance request failed: ${errors.join(", ")}`);
}

async function fetchMacroInfo(assetBtcSymbol) {
  const [btcCandles, btcTicker, assetBtcCandles] = await Promise.all([
    fetchBinanceCandles("BTCUSDT", "1d", 365),
    fetchBinanceTicker24h("BTCUSDT"),
    fetchBinanceCandles(assetBtcSymbol, "1d", 30),
  ]);
  const btcCloses = btcCandles.map((candle) => candle.close);
  const assetBtcCloses = assetBtcCandles.map((candle) => candle.close);
  return {
    btcChange24h: btcTicker.changePercent,
    btcEma200: calculateEma(btcCloses, 200),
    btcPrice: btcTicker.price,
    dotBtcChange7d: calculatePeriodChange(assetBtcCloses, 7),
  };
}

async function fetchFuturesJson(path) {
  const errors = [];
  for (const base of ["https://fapi.binance.com", "https://fapi1.binance.com"]) {
    try {
      const response = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
      if (response.ok) return await readJsonResponse(response, base);
      errors.push(`${base} ${response.status}`);
    } catch (error) {
      errors.push(`${base} ${error.message}`);
    }
  }
  throw new Error(`Binance futures failed: ${errors.join(", ")}`);
}

async function readJsonResponse(response, source) {
  const body = await response.text();
  if (!body.trim()) throw new Error(`${source} empty response`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${source} invalid JSON`);
  }
}

async function fetchDerivativesInfo(symbol) {
  const [premium, openInterest, history, ratios] = await Promise.all([
    fetchFuturesJson(`/fapi/v1/premiumIndex?symbol=${symbol}`),
    fetchFuturesJson(`/fapi/v1/openInterest?symbol=${symbol}`),
    fetchFuturesJson(`/futures/data/openInterestHist?symbol=${symbol}&period=1d&limit=2`),
    fetchFuturesJson(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1d&limit=1`),
  ]);
  const currentHistory = history.at(-1);
  const previousHistory = history[0];
  const currentOpenInterest = Number(openInterest.openInterest);
  const previousOpenInterest = Number(previousHistory?.sumOpenInterest ?? 0);
  return {
    fundingRatePercent: Number(premium.lastFundingRate) * 100,
    longShortRatio: Number(ratios.at(-1)?.longShortRatio ?? 0),
    openInterestChange24h: previousOpenInterest ? ((Number(currentHistory?.sumOpenInterest ?? currentOpenInterest) - previousOpenInterest) / previousOpenInterest) * 100 : null,
    openInterestDot: currentOpenInterest,
    openInterestUsd: currentOpenInterest * Number(premium.markPrice),
  };
}

async function fetchEtfInfo() {
  const [detailsResponse, historyResponse] = await Promise.all([
    fetch("https://api.primary.21shares.com/api/product_details/TDOT", { headers: { accept: "application/json" } }),
    fetch("https://api.primary.21shares.com/api/product_valuation_history/TDOT", { headers: { accept: "application/json" } }),
  ]);
  if (!detailsResponse.ok || !historyResponse.ok) throw new Error("TDOT ETF request failed");
  const details = (await detailsResponse.json()).data;
  const history = (await historyResponse.json()).data;
  const latest = history[0];
  const comparison = history[Math.min(5, history.length - 1)];
  const average30dVolume = latest?.trading_volume_30d ?? details["30day_trading_volume"];
  return {
    aum: latest?.total_nav ?? details.total_nav,
    aumChange5d: comparison?.total_nav ? (((latest?.total_nav ?? details.total_nav) - comparison.total_nav) / comparison.total_nav) * 100 : null,
    average30dVolume,
    dailyVolume: latest?.daily_trading_volume ?? details.daily_trading_volume,
    dayChange: latest?.market_price_percentage_change ?? 0,
    dotHoldings: details.constituents?.[0]?.quantity ?? 0,
    marketPrice: latest?.market_price ?? details.nav_per_unit,
    nav: latest?.nav_per_share ?? details.nav_per_unit,
    premiumDiscount: latest?.premium_discount ?? 0,
    sharesChange5d: comparison?.total_units_outstanding ? (((latest?.total_units_outstanding ?? details.total_units_outstanding) - comparison.total_units_outstanding) / comparison.total_units_outstanding) * 100 : null,
    sharesOutstanding: latest?.total_units_outstanding ?? details.total_units_outstanding,
    valuationDate: latest?.valuation_date ?? details.valuation_date,
    volumeRatio: average30dVolume ? (latest?.daily_trading_volume ?? details.daily_trading_volume) / average30dVolume : null,
  };
}

async function fetchOnchainInfo() {
  const keys = {
    activeEra: "0x5f3e4907f716ac89b6347d15ececedca487df464e44a534ba6b0cbb32407b587",
    issuance: "0xc2261276cc9d1f8598ea4b6a74b15c2f57c875e4cff74148e4628f264b974c80",
    nominators: "0x5f3e4907f716ac89b6347d15ececedcaf99b25852d3d69419882da651375cdb3",
    referendumCount: "0x0f6738a0ee80c8e74cd2c7417c1e25567f17cdfbfa73331856cca0acddd7842e",
    totalStakePrefix: "0x5f3e4907f716ac89b6347d15ececedcaa141c4fe67c2d11f4a10c6aca7a79a04",
    validatorCount: "0x5f3e4907f716ac89b6347d15ececedca138e71612491192d68deab7e6f563fe1",
  };
  const activeEraHex = await polkadotRpc("state_getStorage", [keys.activeEra], POLKADOT_ASSET_HUB_RPC_ENDPOINTS);
  if (!activeEraHex || activeEraHex.length < 10) throw new Error("Active era unavailable");
  const activeEra = decodeLittleEndianHex(`0x${activeEraHex.slice(2, 10)}`);
  const totalStakeKey = await storageMapKeyU32(keys.totalStakePrefix, activeEra);
  const storageKeys = [keys.issuance, keys.validatorCount, keys.nominators, keys.referendumCount, totalStakeKey];
  const [storageRows, latestBlock, health, bestHeader, finalizedHash] = await Promise.all([
    polkadotRpc("state_queryStorageAt", [storageKeys], POLKADOT_ASSET_HUB_RPC_ENDPOINTS),
    polkadotRpc("chain_getBlock"),
    polkadotRpc("system_health"),
    polkadotRpc("chain_getHeader"),
    polkadotRpc("chain_getFinalizedHead"),
  ]);
  const finalizedHeader = await polkadotRpc("chain_getHeader", [finalizedHash]);
  const storage = new Map(storageRows[0]?.changes ?? []);
  const totalIssuance = decodeLittleEndianHex(storage.get(keys.issuance) ?? null) / 10_000_000_000;
  const totalStaked = decodeLittleEndianHex(storage.get(totalStakeKey) ?? null) / 10_000_000_000;
  const bestBlock = Number.parseInt(bestHeader.number, 16);
  const finalizedBlock = Number.parseInt(finalizedHeader.number, 16);
  return {
    activeValidators: decodeLittleEndianHex(storage.get(keys.validatorCount) ?? null),
    averageExtrinsics: latestBlock.block.extrinsics.length,
    nominatorCount: decodeLittleEndianHex(storage.get(keys.nominators) ?? null),
    networkHealthy: !health.isSyncing && bestBlock - finalizedBlock <= 5,
    recentOngoingReferenda: -1,
    referendumCount: decodeLittleEndianHex(storage.get(keys.referendumCount) ?? null),
    stakedPercent: totalIssuance ? (totalStaked / totalIssuance) * 100 : 0,
    totalIssuance,
    totalStaked,
  };
}

async function polkadotRpc(method, params = [], endpoints = POLKADOT_RELAY_RPC_ENDPOINTS) {
  const candidates = Array.isArray(endpoints) ? endpoints : [endpoints];
  const poolKey = candidates.join("|");
  const preferred = rpcPreferredEndpoint.get(poolKey) ?? 0;
  const ordered = [...candidates.slice(preferred), ...candidates.slice(0, preferred)];
  const errors = [];
  for (const endpoint of ordered) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        errors.push(`${new URL(endpoint).hostname} ${response.status}`);
        continue;
      }
      const data = await response.json();
      if (data.error || data.result === undefined) {
        errors.push(`${new URL(endpoint).hostname} ${data.error?.message || "invalid response"}`);
        continue;
      }
      rpcPreferredEndpoint.set(poolKey, candidates.indexOf(endpoint));
      return data.result;
    } catch (error) {
      errors.push(`${new URL(endpoint).hostname} ${error.name === "TimeoutError" ? "timeout" : "connection failed"}`);
    }
  }
  throw new Error(`Polkadot RPC failed: ${errors.join(", ")}`);
}

function decodeLittleEndianHex(value) {
  if (!value) return 0;
  const bytes = value.slice(2).match(/.{2}/g) ?? [];
  return Number(BigInt(`0x${bytes.reverse().join("") || "0"}`));
}

async function storageMapKeyU32(prefix, value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  const { h64Raw } = await xxhash();
  const hash = h64Raw(bytes, 0n).toString(16).padStart(16, "0").match(/.{2}/g)?.reverse().join("") ?? "";
  const encoded = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hash}${encoded}`;
}

async function fetchAssetContext(asset) {
  const repos = asset.repos;
  const githubHeaders = {
    accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
  const [newsResult, repoResults] = await Promise.all([
    fetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN", { headers: { accept: "application/json" } })
      .then(async (response) => (response.ok ? response.json() : { Data: [] }))
      .catch(() => ({ Data: [] })),
    Promise.all(repos.map(async (repoInfo) => {
      const repo = `${repoInfo.owner}/${repoInfo.repo}`;
      const branchParam = repoInfo.branch ? `&sha=${encodeURIComponent(repoInfo.branch)}` : "";
      const [apiCommits, releases] = await Promise.all([
        fetch(`https://api.github.com/repos/${repo}/commits?per_page=4${branchParam}`, { headers: githubHeaders })
          .then(async (response) => (response.ok ? response.json() : []))
          .catch(() => []),
        fetch(`https://api.github.com/repos/${repo}/releases?per_page=1`, { headers: githubHeaders })
          .then(async (response) => (response.ok ? response.json() : []))
          .catch(() => []),
      ]);
      const commits = apiCommits.length ? apiCommits : await fetchGitHubAtomCommits(repoInfo);
      return { repo: repoInfo.repo, commits, releases };
    })),
  ]);

  const newsPattern = new RegExp(asset.newsKeywords.map(escapeRegExp).join("|"), "i");
  const articles = (newsResult.Data || []).filter((item) => newsPattern.test(`${item.title || ""} ${item.body || ""}`));
  const newsScoreRaw = articles.slice(0, 8).reduce((sum, item) => sum + scoreNewsText(`${item.title || ""} ${item.body || ""}`), 0);
  const newsScore = newsScoreRaw >= 2 ? Math.min(12, 4 + newsScoreRaw * 2) : newsScoreRaw <= -2 ? -Math.min(12, 4 + Math.abs(newsScoreRaw) * 2) : 0;
  const activeRepoCount = repoResults.filter(({ commits }) => {
    const now = Date.now();
    const rows = commits;
    const date = rows[0]?.commit?.author?.date;
    return date && now - new Date(date).getTime() <= 30 * 86_400_000;
  }).length;
  const developmentIndex = calculateDevelopmentIndex(repoResults, repos.length);
  return { articleCount: articles.length, newsBalance: newsScoreRaw, newsScore, activeRepoCount, developmentIndex };
}

async function fetchGitHubAtomCommits(repoInfo) {
  const branchCandidates = [...new Set([repoInfo.branch, "main", "master", "develop"].filter(Boolean))];
  for (const branch of branchCandidates) {
    try {
      const response = await fetch(`https://github.com/${repoInfo.owner}/${repoInfo.repo}/commits/${branch}.atom`, {
        headers: { accept: "application/atom+xml, application/xml, text/xml" },
      });
      if (!response.ok) continue;
      const xml = await response.text();
      const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, 4);
      const commits = entries.map(([, entry]) => {
        const title = decodeXml(matchXml(entry, "title") || "최근 커밋").replace(/\s+/g, " ").trim();
        const updated = matchXml(entry, "updated") || new Date().toISOString();
        const href = entry.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/)?.[1] || `https://github.com/${repoInfo.owner}/${repoInfo.repo}/commits/${branch}`;
        return {
          html_url: decodeXml(href),
          commit: {
            message: title,
            author: { date: updated },
          },
        };
      });
      if (commits.length) return commits;
    } catch {
      // Try the next likely branch.
    }
  }
  return [];
}

function matchXml(xml, tag) {
  return xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() ?? "";
}

function decodeXml(value) {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function calculateDevelopmentIndex(repoResults, repoCount) {
  const now = Date.now();
  const commits = repoResults.flatMap(({ repo, commits: rows }) => rows.map((item) => ({ repo, date: item.commit?.author?.date })));
  const releases = repoResults.flatMap(({ releases: rows }) => rows.map((item) => item.published_at));
  if (!commits.length && !releases.length) return -1;
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

function scoreNewsText(text) {
  const positive = ["adoption", "approve", "approved", "breakthrough", "growth", "launch", "milestone", "partnership", "release", "upgrade"];
  const negative = ["attack", "delay", "exploit", "hack", "lawsuit", "outage", "reject", "risk", "scam", "vulnerability"];
  const normalized = text.toLowerCase();
  const positiveHits = positive.filter((word) => normalized.includes(word)).length;
  const negativeHits = negative.filter((word) => normalized.includes(word)).length;
  return Math.max(-3, Math.min(3, positiveHits - negativeHits));
}

function calculateSignal(coin, timeframe, candles, ticker24h, context, macro, derivatives, onchain, etf) {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const candlePrice = closes.at(-1) ?? 0;
  const price = Number.isFinite(ticker24h.price) ? ticker24h.price : candlePrice;
  const previous = closes.at(-2) ?? candlePrice;
  const rsi = calculateRsi(closes);
  const ema50 = calculateEma(closes, 50);
  const ema200 = calculateEma(closes, 200);
  const sma20w = calculateSma(closes, 140);
  const macd = calculateMacd(closes);
  const atr = calculateAtr(candles);
  const adx = calculateAdx(candles);
  const bollinger = calculateBollinger(closes);
  const volumeRatio = ratioToAverage(volumes.at(-1) ?? 0, volumes.slice(-21, -1));
  const dayChangePercent = Number.isFinite(ticker24h.changePercent) ? ticker24h.changePercent : null;
  const change7d = calculatePeriodChange(closes, 7);
  const trendState = ema50 !== null && ema200 !== null && price > ema50 && ema50 > ema200 ? 1 : ema50 !== null && ema200 !== null && price < ema50 && ema50 < ema200 ? -1 : 0;
  const btcRegime = macro?.btcEma200 ? (macro.btcPrice >= macro.btcEma200 ? 1 : -1) : 0;
  const result = evaluateDotSignal({
    assetSymbol: coin.symbol,
    above20w: sma20w === null ? null : price >= sma20w,
    activeValidators: onchain?.activeValidators ?? null,
    adx,
    atrPercent: atr && price ? (atr / price) * 100 : null,
    bollingerPosition: bollinger.position,
    btcRegime,
    change24h: dayChangePercent,
    change7d,
    developmentIndex: context.developmentIndex,
    dotBtcChange7d: macro?.dotBtcChange7d ?? null,
    etfDayChange: etf?.dayChange ?? null,
    etfPremiumDiscount: etf?.premiumDiscount ?? null,
    etfSharesChange5d: etf?.sharesChange5d ?? null,
    etfVolumeRatio: etf?.volumeRatio ?? null,
    fundingRatePercent: derivatives?.fundingRatePercent ?? null,
    longShortRatio: derivatives?.longShortRatio ?? null,
    macdHistogram: macd.histogram,
    networkHealthy: onchain?.networkHealthy ?? null,
    newsBalance: context.newsBalance,
    openInterestChange24h: derivatives?.openInterestChange24h ?? null,
    priceUp: price >= previous,
    rsi,
    stakedPercent: onchain?.stakedPercent ?? null,
    trendState,
    volumeRatio,
  });
  const direction = result.direction === "risk" ? "sell" : result.direction;

  return {
    symbol: coin.binanceSymbol,
    asset: coin.symbol,
    coinId: coin.coinId,
    coinName: coin.label,
    marketCapRank: null,
    timeframe,
    direction,
    score: result.score,
    confidence: result.confidence,
    riskLevel: result.riskLevel,
    reason: result.reasons.slice(0, 6).join(" · "),
    price,
    dayChangePercent,
    rsi,
    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    ema50,
    ema200,
    stochasticK: null,
    stochasticD: null,
    cci: null,
    atrPercent: atr && price ? (atr / price) * 100 : null,
    adx,
    bollingerPosition: bollinger.position,
    bollingerWidthPercent: bollinger.widthPercent,
    volumeRatio,
    obvSlope: null,
    candles: closes.slice(-365),
    candleTimes: candles.map((candle) => candle.openTime).slice(-365),
    newsScore: context.newsScore,
    newsArticleCount: context.articleCount,
    activeDevRepos: context.activeRepoCount,
    developmentIndex: context.developmentIndex,
    components: result.components,
    macro,
    derivatives,
    onchain,
    etf,
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
신뢰도: ${signal.confidence}% · 변동 위험: ${signal.riskLevel === "high" ? "높음" : signal.riskLevel === "medium" ? "보통" : "낮음"}
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
        text: `[연결 테스트] 코인 알림\n카카오톡 알림 연결이 정상입니다.\n전송 시각: ${sentAt}`,
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

function calculateSma(values, period) {
  return values.length < period ? null : average(values.slice(-period));
}

function calculateMacd(closes) {
  if (closes.length < 35) return { macd: null, signal: null, histogram: null };
  const series = [];
  for (let end = 26; end <= closes.length; end += 1) {
    const values = closes.slice(0, end);
    const ema12 = calculateEma(values, 12);
    const ema26 = calculateEma(values, 26);
    if (ema12 !== null && ema26 !== null) series.push(ema12 - ema26);
  }
  const macd = series.at(-1) ?? null;
  const signal = calculateEma(series, 9);
  return { macd, signal, histogram: macd !== null && signal !== null ? macd - signal : null };
}

function calculatePeriodChange(values, days) {
  if (values.length <= days) return null;
  const current = values.at(-1);
  const previous = values.at(-1 - days);
  return previous ? ((current - previous) / previous) * 100 : null;
}

function calculateAtr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  let atr = average(ranges.slice(0, period));
  for (let index = period; index < ranges.length; index += 1) atr = (atr * (period - 1) + ranges[index]) / period;
  return atr;
}

function calculateAdx(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const trueRanges = [];
  const plusDm = [];
  const minusDm = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    trueRanges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const dxValues = [];
  for (let end = period; end <= trueRanges.length; end += 1) {
    const atr = average(trueRanges.slice(end - period, end));
    if (!atr) continue;
    const plusDi = (average(plusDm.slice(end - period, end)) / atr) * 100;
    const minusDi = (average(minusDm.slice(end - period, end)) / atr) * 100;
    if (plusDi + minusDi) dxValues.push((Math.abs(plusDi - minusDi) / (plusDi + minusDi)) * 100);
  }
  return dxValues.length >= period ? average(dxValues.slice(-period)) : null;
}

function calculateBollinger(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return { position: null, widthPercent: null };
  const values = closes.slice(-period);
  const middle = average(values);
  const deviation = Math.sqrt(average(values.map((value) => (value - middle) ** 2)));
  const upper = middle + deviation * multiplier;
  const lower = middle - deviation * multiplier;
  return {
    position: upper === lower ? 0.5 : (closes.at(-1) - lower) / (upper - lower),
    widthPercent: middle ? ((upper - lower) / middle) * 100 : null,
  };
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
