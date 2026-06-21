export type SignalDirection = "buy" | "sell" | "neutral";

export interface SignalRecord {
  id: string;
  symbol: string;
  asset?: string;
  coinName?: string;
  marketCapRank?: number;
  timeframe: string;
  direction: SignalDirection;
  score?: number;
  reason: string;
  price: number;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram?: number | null;
  ema50?: number | null;
  ema200?: number | null;
  stochasticK?: number | null;
  stochasticD?: number | null;
  cci?: number | null;
  atrPercent?: number | null;
  bollingerPosition?: number | null;
  volumeRatio: number | null;
  candles?: number[];
  newsScore?: number;
  newsArticleCount?: number;
  components?: Record<string, number>;
  createdAt?: {
    seconds: number;
    nanoseconds: number;
  };
}

export interface WatchItem {
  id: string;
  symbol: string;
  timeframe: string;
  enabled: boolean;
  exchange: "binance";
  rsiBuy: number;
  rsiSell: number;
  volumeSpike: number;
}
