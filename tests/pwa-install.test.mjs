import assert from "node:assert/strict";
import test from "node:test";
import { IOS_HINT_SNOOZE_MS, shouldShowIosHint } from "../src/pwa-install.mjs";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1";
const IPADOS_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const NOW = 1_700_000_000_000;

test("아이폰 사파리에서는 설치 안내를 띄운다", () => {
  assert.equal(shouldShowIosHint({ userAgent: IPHONE_SAFARI, now: NOW }), true);
});

test("아이패드 사파리는 터치 지원으로 가려낸다", () => {
  assert.equal(shouldShowIosHint({ userAgent: IPADOS_SAFARI, maxTouchPoints: 5, now: NOW }), true);
  // 같은 UA를 쓰는 맥 사파리에는 띄우지 않는다.
  assert.equal(shouldShowIosHint({ userAgent: MAC_SAFARI, maxTouchPoints: 0, now: NOW }), false);
});

test("안드로이드와 iOS의 다른 브라우저에는 띄우지 않는다", () => {
  // 안드로이드 크롬은 브라우저가 직접 설치 배너를 띄운다.
  assert.equal(shouldShowIosHint({ userAgent: ANDROID_CHROME, now: NOW }), false);
  assert.equal(shouldShowIosHint({ userAgent: IPHONE_CHROME, now: NOW }), false);
});

test("이미 홈 화면 앱으로 열린 상태면 띄우지 않는다", () => {
  assert.equal(shouldShowIosHint({ userAgent: IPHONE_SAFARI, standalone: true, now: NOW }), false);
});

test("한 번 닫으면 하루 동안 다시 뜨지 않는다", () => {
  const justDismissed = { userAgent: IPHONE_SAFARI, dismissedAt: NOW, now: NOW };
  assert.equal(shouldShowIosHint(justDismissed), false);

  const afterAnHour = { userAgent: IPHONE_SAFARI, dismissedAt: NOW, now: NOW + 60 * 60 * 1000 };
  assert.equal(shouldShowIosHint(afterAnHour), false);

  const justBeforeADay = { userAgent: IPHONE_SAFARI, dismissedAt: NOW, now: NOW + IOS_HINT_SNOOZE_MS - 1 };
  assert.equal(shouldShowIosHint(justBeforeADay), false);

  const afterADay = { userAgent: IPHONE_SAFARI, dismissedAt: NOW, now: NOW + IOS_HINT_SNOOZE_MS };
  assert.equal(shouldShowIosHint(afterADay), true);
});
