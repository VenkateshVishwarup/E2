import { costOf, type CallCost, type TokenUsage } from "./provider.js";

/**
 * Token accounting for one conversation. Every model call in the runtime
 * reports into a meter, so cost per conversation is measured rather than
 * estimated — which is the difference between a ROI claim a CFO can audit and
 * one they can only be asked to believe.
 *
 * Optional by construction: a runtime built without one still works, so
 * metering can never be the reason a conversation fails.
 */
export class CostMeter {
  private calls: CallCost[] = [];

  record(model: string, usage: TokenUsage | undefined): void {
    if (!usage) return;
    this.calls.push(costOf(model, usage));
  }

  /** Returns everything recorded and resets, ready for the next conversation. */
  drain(): CallCost[] {
    const out = this.calls;
    this.calls = [];
    return out;
  }

  get usd(): number {
    return this.calls.reduce((s, c) => s + c.usd, 0);
  }

  get callCount(): number {
    return this.calls.length;
  }
}
