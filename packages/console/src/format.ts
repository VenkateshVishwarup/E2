/**
 * Money, in the minor units the whole system uses.
 *
 * Precision adapts, because these screens legitimately show both ₹7,49,000 of
 * media spend and ₹0.027 of model cost per qualified lead. A single
 * whole-rupee format renders the second as "₹0", which reads as "this costs
 * nothing" when it means "this costs less than a rupee" — a materially
 * different claim on a screen about cost.
 */
export function money(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined) return "—";
  const rupees = v / 100;
  const digits = rupees === 0 ? 0 : Math.abs(rupees) < 1 ? 4 : Math.abs(rupees) < 100 ? 2 : 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency", currency,
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(rupees);
}

/** A ratio as a percentage, or undefined when the denominator is zero. */
export const rate = (n: number, of: number): string | undefined =>
  of === 0 ? undefined : `${((n / of) * 100).toFixed(1)}%`;
