import { describe, it, expect } from "vitest";
import { scrub } from "../src/import/pii.js";

describe("scrub", () => {
  it("redacts email addresses", () => {
    expect(scrub("write to ravi.kumar@example.co.in please"))
      .toBe("write to [EMAIL] please");
  });

  it("redacts Indian mobile numbers in common formats", () => {
    expect(scrub("call +91 98765 43210")).toBe("call [PHONE]");
    expect(scrub("call 9876543210")).toBe("call [PHONE]");
    expect(scrub("call +919876543210")).toBe("call [PHONE]");
    expect(scrub("call 91-9876543210")).toBe("call [PHONE]");
    expect(scrub("call 98765-43210")).toBe("call [PHONE]");
  });

  it("does not redact numbers that merely look phone-ish", () => {
    // Indian mobiles start 6-9 and are exactly 10 digits.
    expect(scrub("roll number 1234567890")).toBe("roll number 1234567890");
    expect(scrub("id 98765432109876")).toBe("id 98765432109876");
  });

  it("redacts Aadhaar-shaped and PAN-shaped identifiers", () => {
    expect(scrub("aadhaar 1234 5678 9012")).toBe("aadhaar [GOVID]");
    expect(scrub("pan ABCDE1234F")).toBe("pan [GOVID]");
  });

  it("redacts card numbers", () => {
    expect(scrub("card 4111 1111 1111 1111")).toBe("card [CARD]");
  });

  it("leaves qualification-relevant text intact", () => {
    const s = "I want the executive MBA, budget around 12 lakhs, starting this intake";
    expect(scrub(s)).toBe(s);
  });

  it("does not redact a plain year or a small number", () => {
    expect(scrub("graduated in 2019 with 4 years experience"))
      .toBe("graduated in 2019 with 4 years experience");
  });
});
