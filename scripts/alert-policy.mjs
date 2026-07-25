const PUMP_ALERT_THRESHOLD = 10;

export function getAlertType(previous, signal) {
  if (signal.direction !== "neutral" && (!previous || previous.direction !== signal.direction)) {
    return "signal";
  }
  if (previous && previous.score <= 0 && signal.score > 0) {
    return "positive";
  }
  if (
    previous
    && previous.dayChangePercent < PUMP_ALERT_THRESHOLD
    && (signal.dayChangePercent ?? 0) >= PUMP_ALERT_THRESHOLD
  ) {
    return "pump";
  }
  return null;
}
