export interface ChartCandle {
  openTime: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface LiveTicker {
  price: number;
  volume: number;
}

export function mergeLiveTodayCandle(
  candles: ChartCandle[],
  ticker: LiveTicker | null,
  now?: number,
): ChartCandle[];
