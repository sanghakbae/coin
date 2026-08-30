# Coin Signal Alert

React + Vite + Firebase 기반 개인용 암호화폐 신호 알림 프로젝트입니다.

기본 구조는 `GitHub Actions schedule -> Firestore -> React + Kakao`입니다. GitHub Actions가 10분마다 DOT를 스캔하고, Binance 일봉 데이터를 기준으로 매수·매도, 종합점수 플러스 전환, 24시간 10% 이상 상승 조건에 새로 진입하면 카카오톡 "나에게 보내기" API로 알림을 보냅니다. Firebase Functions/Blaze 요금제 없이 운영하는 무료 구성입니다.

## 포함된 것

- React/Vite 실시간 대시보드
- Binance 실시간 가격/차트 기반 Top 50 화면
- GitHub Actions 스케줄러 `Scheduled Coin Alerts`
- CoinGecko 시총 상위 50 후보 선정
- Firestore 관심 코인만 자동 신호/카카오 알림 대상으로 사용
- Binance USDT 현물 캔들 수집
- 관심 코인 24시간 10% 이상 상승 시 카카오 알림
- `1d` 일봉 기준 10분마다 자동 스캔
- EMA 50/200, RSI, 거래량 급증, 24시간 상승률 점수
- 카카오 access token 자동 갱신 후 "나에게 보내기"
- 중복 알림 방지용 `/state/{symbol_timeframe}`
- GitHub Pages 프론트 배포 + GitHub Actions 무료 스케줄 알림

## 로컬 설정

```bash
npm install
npm --prefix functions install
cp .env.example .env.local
cp .firebaserc.example .firebaserc
```

`.env.local`에는 Firebase 웹앱 설정을 입력합니다.

```bash
npm run dev
```

## GitHub Actions 자동 알림 Secrets

자동 알림은 Firebase Functions Secret이 아니라 GitHub Secrets를 씁니다. GitHub repository `Settings > Secrets and variables > Actions`에 아래 값을 등록합니다.

```text
FIREBASE_SERVICE_ACCOUNT_COIN_F1318
KAKAO_REST_API_KEY
KAKAO_CLIENT_SECRET
KAKAO_REFRESH_TOKEN
```

`KAKAO_CLIENT_SECRET`은 카카오 앱에서 Client Secret을 사용하지 않으면 비워둘 수 있습니다.

## 카카오 토큰 준비

1. 카카오 디벨로퍼스에서 앱을 만들고 REST API 키를 확인합니다.
2. 카카오 로그인 동의 항목에서 `talk_message` 권한을 활성화합니다.
3. OAuth 인증으로 refresh token을 1회 발급합니다.
4. refresh token을 `KAKAO_REFRESH_TOKEN` secret에 저장합니다.

개인용 "나에게 보내기"는 refresh token 기반으로 access token을 갱신해서 발송합니다.

## Firestore 문서

GitHub Actions 스케줄러가 아래 컬렉션을 씁니다.

```text
/signals/{symbol_timeframe}
/scanRuns/{autoId}
/state/{symbol_timeframe}
/alertHistory/{autoId}
```

현재 보안 규칙은 `signals` 읽기만 공개하고 모든 쓰기는 차단합니다. 운영 시 로그인 사용자만 읽도록 바꿀 수 있습니다.

## GitHub Secrets

GitHub Pages 배포에 아래 값을 등록합니다.

```text
FIREBASE_PROJECT_ID
VITE_FIREBASE_API_KEY
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
VITE_FIREBASE_MEASUREMENT_ID
```

GitHub Actions는 `main` 브랜치 push 또는 수동 실행으로 GitHub Pages를 배포합니다. 자동 카카오 알림은 `.github/workflows/scheduled-alerts.yml`이 10분마다 별도로 실행합니다.

## 홈 화면 앱(PWA)

같은 사이트를 스토어 등록 없이 홈 화면에 설치해 쓸 수 있습니다. 별도 화면이 아니라
지금 사이트를 그대로 감싼 것이라, 웹으로 열든 앱으로 열든 같은 코드가 돕니다.

- `public/manifest.webmanifest` — 앱 이름(코인거래추천), 테마색, 아이콘, 주소창 없는 실행(`standalone`)
- `scripts/sw-template.js` — 서비스워커 원본. 빌드할 때 `scripts/build-sw.mjs`가
  `dist/` 목록과 내용 해시를 채워 `dist/sw.js`를 만든다
- `src/pwa.tsx` — 서비스워커 등록, 새 버전 안내, iOS 설치 안내

### 아이콘 다시 만들기

모든 아이콘은 `assets/icon.svg` 하나에서 나옵니다. 색이나 모양을 바꾸려면 그 파일만
고치고 아래를 실행하면 192·512·180·파비콘이 전부 따라옵니다. 결과물은 `public/`에
커밋되어 있어 배포 빌드에는 변환기가 필요 없습니다.

```bash
npm run icons
```

`rsvg-convert`(brew install librsvg) 또는 ImageMagick 중 하나가 있으면 됩니다.
색을 바꿨다면 `manifest.webmanifest`와 `index.html`의 `theme-color`도 함께 확인하세요.

### 새 버전 배포

새 버전은 자동으로 적용되지 않습니다. 서비스워커가 대기 상태로 들어가고 화면에
안내가 뜨며, 사용자가 "새로고침"을 눌러야 교체됩니다. 작성 중이던 입력을 지키기
위한 것이므로 자동 새로고침으로 바꾸지 마세요.

### 손대면 안 되는 것

- 입력칸 글자 크기는 16px 미만으로 내리지 않습니다. iOS가 포커스 시 화면을 확대해
  오른쪽이 잘립니다. 값은 `--input-font-size` 한 곳에서만 정하고
  `tests/mobile-input-zoom.test.mjs`가 이를 막습니다.
- 확대를 막는 `user-scalable=no`는 쓰지 않습니다. 확대해서 보는 사용자를 막습니다.
- 서비스워커의 `caches.match`에는 `ignoreVary: true`가 필요합니다. 호스팅이
  `Vary: Origin`을 붙이면 캐시가 통째로 빗나가 오프라인에서 흰 화면이 뜹니다.

## Custom domain

현재 프론트는 GitHub Pages에서 `dot.sanghak.kr`로 배포합니다. `public/CNAME`에 커스텀 도메인이 들어 있으며, GitHub Pages 설정에서 Source는 GitHub Actions입니다.

## 기본 신호 조건

현재 기본값은 [functions/src/index.ts](/functions/src/index.ts)에 고정되어 있습니다.

```text
market universe: Firestore watchlist within CoinGecko market cap top 50
exchange: Binance spot USDT pairs
timeframes: 1d
schedule: every 30 minutes
buy threshold: score >= 50
sell threshold: score <= -50
max alerts per run: 8
pump alert: 24h change >= 10%
```

신호 점수는 추세, RSI, 거래량, 24시간 상승률 점수를 합산합니다. 이 값들은 백테스트 결과에 맞춰 조정하는 편이 좋습니다.

## 운영 메모

- CoinGecko 무료 API는 호출 제한이 있으므로 30분 주기로 시작합니다.
- Binance 캔들은 심볼당 1년치 일봉 365개를 호출합니다.
- 이 시스템은 자동 매매가 아니라 신호 알림용입니다. 실제 주문 전에는 백테스트, 페이퍼 트레이딩, 손절/포지션 크기 규칙이 필요합니다.
