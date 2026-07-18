const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function developmentContribution(index) {
  if (index < 0) return 0;
  if (index >= 80) return 10;
  if (index >= 65) return 7;
  if (index >= 50) return 3;
  if (index >= 35) return -3;
  if (index >= 20) return -7;
  return -10;
}

export function evaluateDotSignal(input) {
  const assetSymbol = input.assetSymbol || "DOT";
  const reasons = [];
  const components = {};
  const add = (key, value, reason) => {
    components[key] = Math.round(value);
    if (value !== 0 && reason) reasons.push(reason);
  };

  add("rsi", input.rsi == null ? 0 : input.rsi <= 30 ? 18 : input.rsi >= 70 ? -18 : 0,
    input.rsi == null ? "" : input.rsi <= 30 ? `RSI ${input.rsi.toFixed(1)}: 과매도 반등 후보` : input.rsi >= 70 ? `RSI ${input.rsi.toFixed(1)}: 과열 구간` : "");
  add("trend", input.trendState * 18,
    input.trendState > 0 ? "현재가·50일·200일선이 장기 상승 배열" : input.trendState < 0 ? "현재가·50일·200일선이 장기 하락 배열" : "");
  add("sma20w", input.above20w == null ? 0 : input.above20w ? 10 : -10,
    input.above20w == null ? "" : input.above20w ? "현재가가 20주 평균선 위" : "현재가가 20주 평균선 아래");
  add("macd", input.macdHistogram == null ? 0 : input.macdHistogram > 0 ? 8 : -8,
    input.macdHistogram == null ? "" : input.macdHistogram > 0 ? "MACD 상승 힘 우세" : "MACD 하락 힘 우세");

  const volumeScore = input.volumeRatio != null && input.volumeRatio >= 1.5 ? (input.priceUp ? 8 : -8) : 0;
  add("volume", volumeScore, volumeScore ? `거래량이 20일 평균의 ${input.volumeRatio.toFixed(1)}배` : "");
  add("dayChange", input.change24h == null ? 0 : input.change24h >= 10 ? 6 : input.change24h <= -8 ? -6 : 0,
    input.change24h == null ? "" : input.change24h >= 10 ? "24시간 10% 이상 상승" : input.change24h <= -8 ? "24시간 낙폭 확대" : "");
  add("weekChange", input.change7d == null ? 0 : input.change7d > 8 ? 5 : input.change7d < -8 ? -5 : 0,
    input.change7d == null ? "" : input.change7d > 8 ? "7일 상대 추세 강세" : input.change7d < -8 ? "7일 상대 추세 약세" : "");

  const newsScore = input.newsBalance >= 2 ? Math.min(10, 4 + input.newsBalance * 2) : input.newsBalance <= -2 ? -Math.min(10, 4 + Math.abs(input.newsBalance) * 2) : 0;
  add("news", newsScore, newsScore > 0 ? `최근 ${assetSymbol} 뉴스에서 긍정 재료 우세` : newsScore < 0 ? `최근 ${assetSymbol} 뉴스에서 부정 재료 우세` : "");
  const devScore = developmentContribution(input.developmentIndex);
  add("development", devScore, input.developmentIndex >= 0 ? `공식 GitHub 개발 지수 ${input.developmentIndex}점` : "");
  add("network", input.networkHealthy == null ? 0 : input.networkHealthy ? 2 : -8,
    input.networkHealthy == null ? "" : input.networkHealthy ? `${assetSymbol} 네트워크 확정 상태 정상` : `${assetSymbol} 네트워크 동기화·확정 지연`);

  add("btcRegime", input.btcRegime * 10,
    input.btcRegime > 0 ? "BTC가 200일선 위: 알트코인 시장 환경 우호" : input.btcRegime < 0 ? "BTC가 200일선 아래: 시장 환경 방어적" : "");
  add("dotBtc", input.dotBtcChange7d == null ? 0 : input.dotBtcChange7d >= 5 ? 6 : input.dotBtcChange7d <= -5 ? -6 : 0,
    input.dotBtcChange7d == null ? "" : input.dotBtcChange7d >= 5 ? `${assetSymbol}가 최근 7일 BTC보다 강함` : input.dotBtcChange7d <= -5 ? `${assetSymbol}가 최근 7일 BTC보다 약함` : "");

  let derivativeScore = 0;
  if (input.openInterestChange24h != null && Math.abs(input.openInterestChange24h) >= 5) {
    derivativeScore += input.openInterestChange24h > 0 ? (input.change24h != null && input.change24h >= 0 ? 4 : -4) : -2;
  }
  if (input.fundingRatePercent != null) {
    if (input.fundingRatePercent >= 0.05) derivativeScore -= 4;
    if (input.fundingRatePercent <= -0.05) derivativeScore += 2;
  }
  if (input.longShortRatio != null) {
    if (input.longShortRatio >= 2) derivativeScore -= 3;
    if (input.longShortRatio <= 0.7) derivativeScore += 2;
  }
  derivativeScore = clamp(derivativeScore, -10, 10);
  add("derivatives", derivativeScore, derivativeScore > 0 ? "선물 미결제약정·펀딩 수급 우호" : derivativeScore < 0 ? "선물 포지션 과열 또는 약세 수급" : "");

  const bollingerScore = input.bollingerPosition == null ? 0 : input.bollingerPosition > 1 && input.volumeRatio != null && input.volumeRatio >= 1.2 ? 4 : input.bollingerPosition < 0 && input.volumeRatio != null && input.volumeRatio >= 1.2 ? -4 : 0;
  add("breakout", bollingerScore, bollingerScore > 0 ? "볼린저 상단 거래량 돌파" : bollingerScore < 0 ? "볼린저 하단 거래량 이탈" : "");

  let stakingScore = 0;
  if (input.stakedPercent != null) stakingScore += input.stakedPercent >= 45 && input.stakedPercent <= 70 ? 2 : input.stakedPercent < 30 ? -3 : 0;
  if (input.activeValidators != null) stakingScore += input.activeValidators >= 500 ? 2 : input.activeValidators < 300 ? -2 : 0;
  add("staking", clamp(stakingScore, -4, 4), stakingScore > 0 ? "스테이킹 참여와 검증인 보안 상태 양호" : stakingScore < 0 ? "스테이킹·검증인 보안 지표 약화" : "");

  let etfScore = 0;
  if (input.etfSharesChange5d != null) etfScore += input.etfSharesChange5d > 0 ? 6 : input.etfSharesChange5d < 0 ? -6 : 0;
  if (input.etfVolumeRatio != null && input.etfVolumeRatio >= 2) etfScore += input.etfDayChange != null && input.etfDayChange >= 0 ? 2 : -2;
  if (input.etfPremiumDiscount != null) etfScore += input.etfPremiumDiscount > 1 ? -1 : input.etfPremiumDiscount < -1 ? 1 : 0;
  add("etf", clamp(etfScore, -8, 8), etfScore > 0 ? "TDOT ETF 기관 수급 개선" : etfScore < 0 ? "TDOT ETF 자금·거래 수급 약화" : "");

  const score = Math.round(Object.values(components).reduce((sum, value) => sum + value, 0));
  const direction = score >= 35 ? "buy" : score <= -35 ? "risk" : "neutral";
  let confidence = 48 + Math.min(25, Math.abs(score) * 0.45);
  if (input.adx != null) confidence += input.adx >= 25 ? 12 : input.adx < 20 ? -8 : 0;
  if (input.atrPercent != null && input.atrPercent >= 8) confidence -= 8;
  if (input.developmentIndex < 0) confidence -= 8;
  confidence = Math.round(clamp(confidence, 20, 95));
  const riskLevel = input.atrPercent == null ? "unknown" : input.atrPercent >= 8 ? "high" : input.atrPercent >= 4 ? "medium" : "low";

  if (input.adx != null && input.adx < 20) reasons.push(`ADX ${input.adx.toFixed(1)}: 횡보 가능성으로 신호 신뢰도 낮춤`);
  if (input.atrPercent != null && input.atrPercent >= 8) reasons.push(`ATR ${input.atrPercent.toFixed(1)}%: 변동성 위험 높음`);
  if (!reasons.length) reasons.push("뚜렷한 방향 우위가 없습니다.");

  return { components, confidence, direction, reasons, riskLevel, score };
}
