export const IOS_HINT_SNOOZE_MS = 24 * 60 * 60 * 1000;

// 안드로이드 크롬은 브라우저가 직접 설치 배너를 띄우지만 iOS 사파리에는 그런
// 버튼이 없다. 방법을 알려주지 않으면 아무도 설치하지 못하므로 iOS 사파리에만
// 안내를 띄운다. iOS의 다른 브라우저는 홈 화면 추가 흐름이 달라 제외한다.
export function isIosSafari(userAgent, maxTouchPoints = 0) {
  if (!userAgent) return false;
  // 아이패드는 iPadOS 13부터 데스크톱 사파리와 같은 UA를 쓴다. 터치 지원 여부로 가른다.
  const iosDevice = /iPhone|iPad|iPod/.test(userAgent) || (userAgent.includes("Macintosh") && maxTouchPoints > 1);
  const otherIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|Whale|DuckDuckGo/.test(userAgent);
  return iosDevice && !otherIosBrowser;
}

export function shouldShowIosHint({ userAgent, maxTouchPoints = 0, standalone = false, dismissedAt = 0, now = 0 }) {
  if (standalone) return false;
  if (!isIosSafari(userAgent, maxTouchPoints)) return false;
  // 한 번 닫으면 하루 동안 다시 뜨지 않는다.
  return now - dismissedAt >= IOS_HINT_SNOOZE_MS;
}
