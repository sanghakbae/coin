export type SignalDirection = "buy" | "risk" | "neutral";

export interface DotSignalInput {
  rsi: number | null;
  trendState: -1 | 0 | 1;
  above20w: boolean | null;
  macdHistogram: number | null;
  volumeRatio: number | null;
  priceUp: boolean;
  change24h: number | null;
  change7d: number | null;
  newsBalance: number;
  developmentIndex: number;
  networkHealthy: boolean | null;
  btcRegime: -1 | 0 | 1;
  dotBtcChange7d: number | null;
  openInterestChange24h: number | null;
  fundingRatePercent: number | null;
  longShortRatio: number | null;
  bollingerPosition: number | null;
  stakedPercent: number | null;
  activeValidators: number | null;
  etfSharesChange5d: number | null;
  etfVolumeRatio: number | null;
  etfDayChange: number | null;
  etfPremiumDiscount: number | null;
  adx: number | null;
  atrPercent: number | null;
}

export interface DotSignalResult {
  components: Record<string, number>;
  confidence: number;
  direction: SignalDirection;
  reasons: string[];
  riskLevel: "low" | "medium" | "high" | "unknown";
  score: number;
}

export function developmentContribution(index: number): number;
export function evaluateDotSignal(input: DotSignalInput): DotSignalResult;
