import { useCallback, useEffect, useRef, useState } from "react";
import { shouldShowIosHint } from "./pwa-install.mjs";

const IOS_HINT_KEY = "pwa:iosHintDismissedAt";
const UPDATE_CHECK_MS = 30 * 60 * 1000;

function readDismissedAt() {
  try {
    return Number(window.localStorage.getItem(IOS_HINT_KEY)) || 0;
  } catch {
    // 사파리 비공개 모드에서는 localStorage 접근 자체가 예외를 던진다.
    return 0;
  }
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export default function PwaPrompts() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const reloadRequested = useRef(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;

    let disposed = false;
    let timer = 0;

    const trackInstalling = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        // controller가 있다는 건 이미 구버전이 돌고 있었다는 뜻이다.
        // 첫 설치까지 "새 버전" 안내를 띄우면 안 된다.
        if (worker.state === "installed" && navigator.serviceWorker.controller && !disposed) {
          setWaitingWorker(worker);
        }
      });
    };

    const onControllerChange = () => {
      // 사용자가 버튼을 눌렀을 때만 새로고침한다. 다른 탭에서 교체가 일어났다고
      // 이 탭을 새로고침하면 작성 중이던 입력이 날아간다.
      if (reloadRequested.current) window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    let active: ServiceWorkerRegistration | null = null;
    const checkForUpdate = () => {
      if (document.visibilityState === "visible") void active?.update();
    };
    document.addEventListener("visibilitychange", checkForUpdate);
    timer = window.setInterval(checkForUpdate, UPDATE_CHECK_MS);

    void navigator.serviceWorker.register("/sw.js").then((registration) => {
      if (disposed) return;
      active = registration;
      if (registration.waiting && navigator.serviceWorker.controller) setWaitingWorker(registration.waiting);
      registration.addEventListener("updatefound", () => trackInstalling(registration.installing));
    }).catch(() => {
      // 등록에 실패해도 사이트는 그대로 동작해야 한다.
    });

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkForUpdate);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  useEffect(() => {
    // 안드로이드 크롬은 브라우저가 직접 설치 배너를 띄우므로
    // beforeinstallprompt를 가로채지 않는다. 판단 규칙은 pwa-install.mjs에 있고
    // tests/pwa-install.test.mjs가 기기별 동작을 고정한다.
    setShowIosHint(shouldShowIosHint({
      userAgent: window.navigator.userAgent,
      maxTouchPoints: window.navigator.maxTouchPoints,
      standalone: isStandalone(),
      dismissedAt: readDismissedAt(),
      now: Date.now(),
    }));
  }, []);

  const applyUpdate = useCallback(() => {
    if (!waitingWorker) return;
    reloadRequested.current = true;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  }, [waitingWorker]);

  const dismissIosHint = useCallback(() => {
    setShowIosHint(false);
    try {
      window.localStorage.setItem(IOS_HINT_KEY, String(Date.now()));
    } catch {
      // 저장을 못 해도 이번 세션에서는 닫힌 상태를 유지한다.
    }
  }, []);

  return (
    <>
      {waitingWorker && (
        <div className="pwaBanner pwaUpdate" role="status">
          <div>
            <strong>새 버전이 준비됐습니다</strong>
            <small>지금 눌러야 교체됩니다. 보던 화면은 그대로 두었습니다.</small>
          </div>
          <div className="pwaActions">
            <button type="button" className="pwaPrimary" onClick={applyUpdate}>
              새로고침
            </button>
            <button type="button" onClick={() => setWaitingWorker(null)}>
              나중에
            </button>
          </div>
        </div>
      )}

      {showIosHint && (
        <div className="pwaBanner pwaInstall" role="dialog" aria-label="홈 화면에 추가하는 방법">
          <div>
            <strong>홈 화면에 추가해서 앱처럼 쓰세요</strong>
            <small>
              아래 <b>공유</b> 버튼을 누르고, 목록을 아래로 내려 <b>홈 화면에 추가</b>를 고르세요.
              목록에 없으면 <b>더 보기</b>를 먼저 누르면 나옵니다.
            </small>
          </div>
          <div className="pwaActions">
            <button type="button" onClick={dismissIosHint}>
              닫기
            </button>
          </div>
        </div>
      )}
    </>
  );
}
