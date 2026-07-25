export function calculateKimchiPremium(upbitPriceKrw, binancePriceUsdt, usdtKrw) {
  if (
    !Number.isFinite(upbitPriceKrw)
    || !Number.isFinite(binancePriceUsdt)
    || !Number.isFinite(usdtKrw)
    || upbitPriceKrw <= 0
    || binancePriceUsdt <= 0
    || usdtKrw <= 0
  ) {
    return null;
  }
  return (upbitPriceKrw / (binancePriceUsdt * usdtKrw) - 1) * 100;
}
