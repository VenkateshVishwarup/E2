/**
 * Order matters: card and Aadhaar patterns are checked before the bare
 * 10-digit phone rule, so a 16-digit card is never partially matched as a
 * phone number.
 */
export const PII_PATTERNS: Array<{ name: string; re: RegExp; token: string }> = [
  { name: "email", re: /[\w.+-]+@[\w-]+\.[\w.-]+/g, token: "[EMAIL]" },
  { name: "card", re: /\b(?:\d[ -]?){15,18}\d\b/g, token: "[CARD]" },
  { name: "aadhaar", re: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g, token: "[GOVID]" },
  { name: "pan", re: /\b[A-Z]{5}\d{4}[A-Z]\b/g, token: "[GOVID]" },
  // NOTE: a leading \b here would be a PII leak. In "+919876543210" the
  // boundary between the "1" of +91 and the first "9" of the number does not
  // exist - both are word characters - so the number would pass through
  // unredacted. Digit lookaround instead of word boundaries.
  { name: "phone", re: /(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{4}[-\s]?\d{5}(?!\d)/g, token: "[PHONE]" },
];

/** Applied before persistence. The event log is never written dirty. */
export function scrub(text: string): string {
  let out = text;
  for (const { re, token } of PII_PATTERNS) out = out.replace(re, token);
  return out;
}
