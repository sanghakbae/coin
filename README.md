# Coin Signal Alert

React + Vite + Firebase 기반 개인용 암호화폐 신호 알림 프로젝트입니다.

기본 구조는 `Cloud Scheduler -> Firebase Functions -> Firestore -> React`입니다. Functions는 CoinGecko 시가총액 상위 50개 코인을 기준으로 Binance USDT 현물 거래쌍을 선별하고, Binance 캔들 데이터와 GDELT 뉴스 제목을 함께 점수화합니다. 강한 매수/매도 신호가 새로 잡히면 카카오톡 "나에게 보내기" API로 알림을 보냅니다.

## 포함된 것

- React/Vite 실시간 대시보드
- Firestore `signals` 컬렉션 구독
- Firebase Functions 스케줄러 `scanCoinSignals`
- CoinGecko 시총 상위 50 후보 선정
- Binance USDT 현물 캔들 수집
- `15m`, `1h`, `4h` 멀티 타임프레임 스캔
- EMA 50/200, MACD, RSI, Stochastic, CCI, Bollinger, ATR, OBV, 거래량 급증 점수
- GDELT 공개 뉴스 제목 기반 간이 감성 점수
- 카카오 access token 자동 갱신 후 "나에게 보내기"
- 중복 알림 방지용 `/state/{symbol_timeframe}`
- Firebase Hosting/Functions/Firestore 배포용 GitHub Actions

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

## Firebase secrets

Functions 배포 전에 아래 secrets를 등록합니다.

```bash
firebase functions:secrets:set KAKAO_REST_API_KEY
firebase functions:secrets:set KAKAO_REFRESH_TOKEN
firebase functions:secrets:set SITE_URL
```

`SITE_URL`은 Firebase Hosting 또는 연결한 DNS 주소입니다.

## 카카오 토큰 준비

1. 카카오 디벨로퍼스에서 앱을 만들고 REST API 키를 확인합니다.
2. 카카오 로그인 동의 항목에서 `talk_message` 권한을 활성화합니다.
3. OAuth 인증으로 refresh token을 1회 발급합니다.
4. refresh token을 `KAKAO_REFRESH_TOKEN` secret에 저장합니다.

개인용 "나에게 보내기"는 refresh token 기반으로 access token을 갱신해서 발송합니다.

## Firestore 문서

Functions가 아래 컬렉션을 씁니다.

```text
/signals/{symbol_timeframe}
/scanRuns/{autoId}
/state/{symbol_timeframe}
```

현재 보안 규칙은 `signals` 읽기만 공개하고 모든 쓰기는 차단합니다. 운영 시 로그인 사용자만 읽도록 바꿀 수 있습니다.

## GitHub Secrets

GitHub Actions 배포에 아래 값을 등록합니다.

```text
FIREBASE_PROJECT_ID
FIREBASE_SERVICE_ACCOUNT
FIREBASE_TOKEN
```

Firebase Hosting만 action으로 배포하고, Functions와 Firestore는 `firebase-tools`로 배포합니다.

## 기본 신호 조건

현재 기본값은 [functions/src/index.ts](/functions/src/index.ts)에 고정되어 있습니다.

```text
market universe: CoinGecko market cap top 50
exchange: Binance spot USDT pairs
timeframes: 15m, 1h, 4h
schedule: every 15 minutes
buy threshold: score >= 42
sell threshold: score <= -42
max alerts per run: 5
```

신호 점수는 추세, MACD, RSI, Stochastic, CCI, Bollinger, 거래량, OBV, 뉴스 점수를 합산합니다. 이 값들은 백테스트 결과에 맞춰 조정하는 편이 좋습니다.

## 운영 메모

- CoinGecko 무료 API는 호출 제한이 있으므로 15분 주기 정도로 시작하는 것을 권장합니다.
- Binance 캔들은 심볼당 타임프레임별로 호출합니다. 상위 50개와 3개 타임프레임이면 한 번에 최대 150개 캔들 요청이 발생합니다.
- GDELT 뉴스 점수는 빠른 MVP용입니다. 더 정확한 뉴스 분석이 필요하면 CryptoPanic, NewsAPI, 자체 FinBERT/LLM 분류 파이프라인으로 교체하세요.
- 이 시스템은 자동 매매가 아니라 신호 알림용입니다. 실제 주문 전에는 백테스트, 페이퍼 트레이딩, 손절/포지션 크기 규칙이 필요합니다.
