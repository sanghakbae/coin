// 이 파일은 원본이고, 실제로 배포되는 것은 build-sw.mjs가 아래 두 자리표시자를
// 채워 만든 dist/sw.js다. 직접 dist/sw.js를 고치지 말 것.
const VERSION = "__BUILD_VERSION__";
const PRECACHE_URLS = __PRECACHE_URLS__;
const SHELL_CACHE = `shell-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;
const OFFLINE_URL = "/index.html";

self.addEventListener("install", (event) => {
  // 여기서 skipWaiting을 부르지 않는다. 새 버전은 사용자가 안내를 눌렀을 때만
  // 교체되어야 하고, 그래야 작성 중이던 입력이 날아가지 않는다.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE).map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // 시세·뉴스 같은 외부 API는 서비스워커가 건드리지 않는다. 오래된 시세를
  // 새 것처럼 보여주는 편이 화면이 비는 것보다 위험하다.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    // 문서는 네트워크 우선. 끊겼을 때만 캐시에 담아 둔 앱 껍데기를 돌려준다.
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(SHELL_CACHE);
        cache.put(OFFLINE_URL, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(OFFLINE_URL, { ignoreVary: true });
        if (cached) return cached;
        return new Response("오프라인입니다.", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    })());
    return;
  }

  // 해시가 붙은 정적 파일이라 캐시 우선이 안전하다.
  event.respondWith((async () => {
    // ignoreVary가 없으면 안 된다. 서버가 Vary: Origin을 붙이면, 미리 받을 때
    // 보낸 요청(Origin 없음)과 페이지가 보내는 crossorigin 요청(Origin 있음)이
    // 다른 것으로 취급돼 캐시가 통째로 빗나가고 오프라인에서 흰 화면이 뜬다.
    const cached = await caches.match(request, { ignoreVary: true });
    if (cached) return cached;
    try {
      const fresh = await fetch(request);
      if (fresh.ok && fresh.type === "basic") {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch (error) {
      return new Response("", { status: 504 });
    }
  })());
});
