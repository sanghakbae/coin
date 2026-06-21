import { useEffect, useMemo, useState } from "react";
import { Activity, Bell, CandlestickChart, CircleAlert, LogIn, LogOut, Radio, Settings } from "lucide-react";
import { GoogleAuthProvider, User, onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { auth, db, hasFirebaseConfig } from "./firebase";
import type { SignalRecord, WatchItem } from "./types";

const demoWatchlist: WatchItem[] = [
  {
    id: "krw-btc",
    symbol: "KRW-BTC",
    timeframe: "15m / 1h / 4h",
    enabled: true,
    exchange: "binance",
    rsiBuy: 30,
    rsiSell: 70,
    volumeSpike: 1.8,
  },
];

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

export default function App() {
  const [signals, setSignals] = useState<SignalRecord[]>([]);
  const [watchlist] = useState<WatchItem[]>(demoWatchlist);
  const [user, setUser] = useState<User | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const latest = signals[0];

  useEffect(() => {
    if (!auth) return undefined;
    return onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (!db) return undefined;
    const signalQuery = query(collection(db, "signals"), orderBy("createdAt", "desc"), limit(20));
    return onSnapshot(signalQuery, (snapshot) => {
      setSignals(
        snapshot.docs.map((doc) => ({
          id: doc.id,
          ...(doc.data() as Omit<SignalRecord, "id">),
        })),
      );
    });
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
                  {hasFirebaseConfig
                    ? "아직 기록된 신호가 없습니다. Functions 스케줄러가 실행되면 여기에 표시됩니다."
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
