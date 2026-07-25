export function mergeLiveTodayCandle(candles, ticker, now = Date.now()) {
  if (!ticker || !Number.isFinite(ticker.price) || ticker.price <= 0) return candles;
  const rows = [...candles];
  const last = rows.at(-1);
  const todayKey = koreanDateKey(now);

  if (last && koreanDateKey(last.openTime) === todayKey) {
    rows[rows.length - 1] = {
      ...last,
      close: ticker.price,
      high: Math.max(last.high, ticker.price),
      low: Math.min(last.low, ticker.price),
    };
    return rows;
  }

  rows.push({
    openTime: now,
    close: ticker.price,
    high: ticker.price,
    low: ticker.price,
    volume: Number.isFinite(ticker.volume) ? ticker.volume : 0,
  });
  return rows;
}

function koreanDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
