export function calculateKimchiPremium(upbitPriceKrw, binancePriceUsdt, usdKrw) {
  if (
    !Number.isFinite(upbitPriceKrw)
    || !Number.isFinite(binancePriceUsdt)
    || !Number.isFinite(usdKrw)
    || upbitPriceKrw <= 0
    || binancePriceUsdt <= 0
    || usdKrw <= 0
  ) {
    return null;
  }
  return (upbitPriceKrw / (binancePriceUsdt * usdKrw) - 1) * 100;
}
