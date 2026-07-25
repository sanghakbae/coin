const SIGNAL_LABELS = {
  buy: "매수",
  neutral: "관망",
  sell: "매도",
};

export function formatDailyReportMessage(signals, sentAt = new Date()) {
  const dateLabel = new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    timeZone: "Asia/Seoul",
  }).format(sentAt);
  const lines = signals.map((signal) => {
    const score = `${signal.score > 0 ? "+" : ""}${signal.score}`;
    const change = `${signal.dayChangePercent > 0 ? "+" : ""}${formatNumber(signal.dayChangePercent, 2)}%`;
    return `${signal.asset} ${SIGNAL_LABELS[signal.direction] ?? "관망"} ${score} · ${formatPrice(signal.price)} · ${change}`;
  });

  return `[22시 종합 리포트 · Binance USDT]
${dateLabel}
${lines.join("\n")}`;
}

export function getKoreanDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isKoreanReportDue(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Seoul",
  }).format(date));
  return hour >= 22;
}

export function splitKakaoText(text, maximumLength = 200) {
  const chunks = [];
  let current = "";

  for (let line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maximumLength) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    while (line.length > maximumLength) {
      chunks.push(line.slice(0, maximumLength));
      line = line.slice(maximumLength);
    }
    current = line;
  }
  if (current) chunks.push(current);
  return chunks;
}

function formatPrice(value) {
  const maximumFractionDigits = value >= 1_000 ? 2 : value >= 1 ? 4 : 6;
  return `${formatNumber(value, maximumFractionDigits)} USDT`;
}

function formatNumber(value, maximumFractionDigits) {
  return Number(value).toLocaleString("ko-KR", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  });
}
