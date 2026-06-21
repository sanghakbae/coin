# Coin Signal Alert

React + Vite + Firebase 기반 개인용 암호화폐 신호 알림 프로젝트입니다.

기본 구조는 `GitHub Actions schedule -> Firestore -> React + Kakao`입니다. GitHub Actions가 30분마다 관심 코인만 스캔하고, Binance 일봉 데이터를 기준으로 매수 신호, 하락 위험, 24시간 10% 이상 상승 조건이 새로 잡히면 카카오톡 "나에게 보내기" API로 알림을 보냅니다. Firebase Functions/Blaze 요금제 없이 운영하는 무료 구성입니다.

## 포함된 것

- React/Vite 실시간 대시보드
- Binance 실시간 가격/차트 기반 Top 50 화면
- GitHub Actions 스케줄러 `Scheduled Coin Alerts`
- CoinGecko 시총 상위 50 후보 선정
- Firestore 관심 코인만 자동 신호/카카오 알림 대상으로 사용
- Binance USDT 현물 캔들 수집
- 관심 코인 24시간 10% 이상 상승 시 카카오 알림
- `1d` 일봉 기준 30분마다 자동 스캔
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
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
VITE_FIREBASE_MEASUREMENT_ID
```

GitHub Actions는 `main` 브랜치 push 또는 수동 실행으로 GitHub Pages를 배포합니다. 자동 카카오 알림은 `.github/workflows/scheduled-alerts.yml`이 30분마다 별도로 실행합니다.

## Custom domain

현재 프론트는 GitHub Pages에서 `coin.sanghak.kr`로 배포합니다. `public/CNAME`에 커스텀 도메인이 들어 있으며, GitHub Pages 설정에서 Source는 GitHub Actions입니다.

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
