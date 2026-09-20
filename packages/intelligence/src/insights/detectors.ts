import { bootstrapUnpairedDiffCI } from "@midfunnel/core/stats/bootstrap";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import { MIN_SUPPORT, type Finding, type FindingCode } from "./types.js";
import type { LeadView } from "./view.js";

export interface DetectorContext {
  specs: ReadonlyMap<number, JourneySpec>;
  /** IANA zone for time-of-day bucketing. Leads answer on local time. */
  tz: string;
}

export interface DetectorResult { findings: Finding[]; skipped?: string }
export type Detector = (views: LeadView[], ctx: DetectorContext) => DetectorResult;

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const conv = (vs: readonly LeadView[]) => vs.map((v) => v.converted);
const rate = (xs: readonly boolean[]) => (xs.length === 0 ? 0 : xs.filter(Boolean).length / xs.length);

/**
 * Every comparison in this module is between two DISJOINT cohorts of different
 * sizes, so the interval is unpaired. The paired interval belongs to replay,
 * where both arms are the same leads.
 */
function split(a: readonly LeadView[], b: readonly LeadView[]) {
  const ra = rate(conv(a)), rb = rate(conv(b));
  return { ra, rb, diff: rb - ra, ci: bootstrapUnpairedDiffCI(conv(a), conv(b)) };
}

const spans = (ci: readonly [number, number]) => ci[0] <= 0 && ci[1] >= 0;

function bucket<T>(m: Map<string, T[]>, key: string, value: T): void {
  const existing = m.get(key);
  if (existing) existing.push(value); else m.set(key, [value]);
}
const supported = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length >= MIN_SUPPORT && b.length >= MIN_SUPPORT;

// ─────────────────────────────────────────────────────────────────────────────

/** Field X has the lowest collection rate; conversations missing it convert Y% worse. */
export const evidenceBottleneck: Detector = (all) => {
  // Only conversations the lead actually engaged with. A lead who never replied
  // is missing EVERY field, so including them makes each field look equally
  // uncollected at exactly the abandonment rate — measuring drop-off twice
  // instead of finding the field that stalls a live conversation.
  const views = all.filter((v) => v.leadReplies > 0);
  const fields = [...new Set(views.flatMap((v) => Object.keys(v.evidence)))];
  if (fields.length === 0) return { findings: [], skipped: "no EvidenceExtracted events" };
  if (views.length < MIN_SUPPORT) {
    return { findings: [], skipped: `only ${views.length} conversations had a reply` };
  }

  const scored = fields.map((field) => {
    const established = (v: LeadView) => v.evidence[field] !== undefined && v.evidence[field] !== null;
    const has = views.filter(established);
    const missing = views.filter((v) => !established(v));
    return { field, has, missing, collection: has.length / views.length };
  }).sort((x, y) => x.collection - y.collection);

  const findings: Finding[] = [];
  for (const s of scored.slice(0, 2)) {
    if (!supported(s.missing, s.has)) continue;
    const { ra, rb, diff, ci } = split(s.missing, s.has);
    // diff is (with - without). A field whose absence HELPS is a different
    // finding and the claim below would misdescribe it, so leave it alone.
    if (spans(ci) || diff <= 0) continue;

    findings.push({
      code: "evidence_bottleneck",
      severity: diff > 0.1 ? "high" : "medium",
      claim: `"${s.field}" is collected in only ${pct(s.collection)} of conversations, ` +
             `and the ones that miss it convert ${pct(Math.abs(diff))} worse.`,
      detail: `converts ${pct(rb)} with the field vs ${pct(ra)} without ` +
              `(n=${s.has.length} / ${s.missing.length})`,
      n: views.length,
      effect: Math.abs(diff),
      ci95: ci,
      suggestion: `Ask for "${s.field}" earlier, or relax its confidence_min so ` +
                  `a partial answer still counts.`,
      evidence: { field: s.field, collectionRate: s.collection, withRate: rb, withoutRate: ra },
    });
  }
  return { findings };
};

/** Cohort A converts materially differently on the same journey version. */
export const segmentDivergence: Detector = (views) => {
  const dimensions: Array<[string, (v: LeadView) => string | null]> = [
    ["campaign", (v) => v.campaignId],
    ...[...new Set(views.flatMap((v) => Object.keys(v.evidence)))].map(
      (f) => [`evidence.${f}`, (v: LeadView) => (v.evidence[f] == null ? null : String(v.evidence[f]))] as [string, (v: LeadView) => string | null],
    ),
  ];

  const findings: Finding[] = [];
  for (const [name, key] of dimensions) {
    const values = [...new Set(views.map(key).filter((x): x is string => x !== null))];
    for (const value of values) {
      const inCohort = views.filter((v) => key(v) === value);
      const rest = views.filter((v) => key(v) !== value && key(v) !== null);
      if (!supported(inCohort, rest)) continue;

      const { ra, rb, diff, ci } = split(rest, inCohort);
      if (spans(ci)) continue;

      findings.push({
        code: "segment_divergence",
        severity: Math.abs(diff) > 0.15 ? "high" : "medium",
        claim: `${name} = ${value} converts ${pct(Math.abs(diff))} ` +
               `${diff > 0 ? "better" : "worse"} than the rest of the cohort.`,
        detail: `${pct(rb)} vs ${pct(ra)} (n=${inCohort.length} / ${rest.length}), ` +
                `95% CI ${pct(ci[0])} .. ${pct(ci[1])}`,
        n: inCohort.length + rest.length,
        effect: Math.abs(diff),
        ci95: ci,
        ...(diff < 0 ? { suggestion:
          `Branch on ${name} = ${value} rather than routing it on the shared score.` } : {}),
        evidence: { dimension: name, value, cohortRate: rb, baselineRate: ra, cohortSize: inCohort.length },
      });
    }
  }
  // At most one finding per dimension. Correlated evidence fields would
  // otherwise fill the report with three phrasings of the same fact.
  const best = new Map<string, Finding>();
  for (const f of findings.sort((a, b) => b.effect - a.effect)) {
    const dim = String(f.evidence.dimension);
    if (!best.has(dim)) best.set(dim, f);
  }
  return { findings: [...best.values()].slice(0, 3) };
};

/** Turn N is where abandonment concentrates. */
export const dropOff: Detector = (views) => {
  const abandoned = views.filter((v) => !v.completed && v.turns.length > 0);
  if (abandoned.length < MIN_SUPPORT) {
    return { findings: [], skipped: `only ${abandoned.length} incomplete conversations (need ${MIN_SUPPORT})` };
  }

  const histogram = new Map<number, number>();
  for (const v of abandoned) histogram.set(v.leadReplies, (histogram.get(v.leadReplies) ?? 0) + 1);
  const [turn, count] = [...histogram.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const share = count / abandoned.length;

  return {
    findings: [{
      code: "drop_off",
      severity: share > 0.4 ? "high" : "medium",
      claim: `Abandonment concentrates after ${turn} lead ${turn === 1 ? "reply" : "replies"} — ` +
             `${pct(share)} of the ${abandoned.length} unfinished conversations stop there.`,
      detail: [...histogram.entries()].sort((a, b) => a[0] - b[0])
        .map(([t, c]) => `${t}:${c}`).join("  "),
      n: abandoned.length,
      effect: share,
      suggestion: turn === 0
        ? "The opener is not earning a reply. Change the pinned opening template."
        : `Leads answer ${turn} time${turn === 1 ? "" : "s"} and stop. Reorder evidence so ` +
          `question ${turn + 1} is not the sensitive one.`,
      evidence: { turn, share, histogram: Object.fromEntries(histogram) },
    }],
  };
};

/** Leads routed cold that converted anyway — the score is wrong. */
export const routingMiscalibration: Detector = (views) => {
  const routed = views.filter((v) => v.decision !== null);
  const cold = routed.filter((v) => v.decision !== "hot");
  const hot = routed.filter((v) => v.decision === "hot");
  if (!supported(cold, hot)) {
    return { findings: [], skipped: `needs ${MIN_SUPPORT} leads on each side of the routing split` };
  }

  const missed = cold.filter((v) => v.converted);
  if (missed.length === 0) return { findings: [] };

  const { ra, rb, ci } = split(cold, hot);
  const missRate = missed.length / cold.length;

  // Three genuinely different diagnoses, and calling any of them by another
  // one's name is worse than saying nothing.
  const verdict = spans(ci) ? "no_signal" : rb > ra ? "leaky" : "inverted";
  const CLAIM = {
    leaky: `${missed.length} leads routed away from handoff converted anyway ` +
           `(${pct(missRate)} of everything not routed hot).`,
    no_signal: "The routing threshold is not separating converters: hot and cold " +
               "convert at statistically indistinguishable rates.",
    inverted: "Routing is inverted — the leads sent to a counsellor convert WORSE " +
              "than the ones nurtured instead.",
  } as const;
  const WHY = {
    leaky: "The gap is real, but the cold tail is not empty, so the threshold is " +
           "leaving revenue behind.",
    no_signal: "An interval spanning zero means the score is not carrying signal.",
    inverted: "The interval excludes zero in the wrong direction, so this is not " +
              "noise: the weights are selecting against conversion.",
  } as const;

  return {
    findings: [{
      code: "routing_miscalibration",
      severity: verdict === "leaky" ? (missRate > 0.1 ? "high" : "medium") : "high",
      claim: CLAIM[verdict],
      detail: `hot converts ${pct(rb)}, everything else ${pct(ra)}, ` +
              `95% CI ${pct(ci[0])} .. ${pct(ci[1])}. ${WHY[verdict]}`,
      n: routed.length,
      effect: missRate,
      ci95: ci,
      suggestion: verdict === "leaky"
        ? "Lower the hot threshold, or add the evidence field these missed leads share."
        : "Re-weight `scoring:` — the current weights do not predict this journey's outcome.",
      evidence: {
        verdict, missed: missed.length, cold: cold.length, hot: hot.length,
        exampleLeads: missed.slice(0, 5).map((v) => v.leadId),
      },
    }],
  };
};

const PARTS: Array<[string, number, number]> =
  [["night", 0, 6], ["morning", 6, 12], ["afternoon", 12, 18], ["evening", 18, 24]];

/** Response rate by time of day, in the journey's own timezone. */
export const timing: Detector = (views, ctx) => {
  const contacted = views.filter((v) => v.firstContactAt !== null);
  if (contacted.length < MIN_SUPPORT * 2) {
    return { findings: [], skipped: `only ${contacted.length} contacted leads` };
  }

  const buckets = new Map<string, LeadView[]>();
  for (const v of contacted) {
    const hour = hourIn(v.firstContactAt!, ctx.tz);
    bucket(buckets, PARTS.find(([, lo, hi]) => hour >= lo && hour < hi)![0], v);
  }

  const eligible = [...buckets.entries()]
    .filter(([, vs]) => vs.length >= MIN_SUPPORT)
    .map(([part, vs]) => ({ part, vs, replyRate: rate(vs.map((v) => v.leadReplies > 0)) }))
    .sort((a, b) => b.replyRate - a.replyRate);

  if (eligible.length < 2) {
    return { findings: [], skipped: `fewer than two times of day clear ${MIN_SUPPORT} leads` };
  }
  const best = eligible[0]!, worst = eligible[eligible.length - 1]!;
  const gap = best.replyRate - worst.replyRate;
  if (gap < 0.05) return { findings: [] };

  return {
    findings: [{
      code: "timing",
      severity: gap > 0.2 ? "high" : "low",
      claim: `First contact in the ${best.part} gets ${pct(gap)} more replies ` +
             `than in the ${worst.part}.`,
      detail: eligible.map((e) => `${e.part} ${pct(e.replyRate)} (n=${e.vs.length})`).join(", ") +
              ` — ${ctx.tz}`,
      n: contacted.length,
      effect: gap,
      suggestion: `Shift send windows toward the ${best.part}; quiet_hours already ` +
                  `encodes the constraint, so this is a scheduling change, not a spec change.`,
      evidence: { tz: ctx.tz, byPart: Object.fromEntries(eligible.map((e) => [e.part, e.replyRate])) },
    }],
  };
};

/** Conversations where a policy rule fired and the lead then disengaged. */
export const policyFriction: Detector = (views) => {
  const fired = views.filter((v) => v.policyFired.length > 0);
  const quiet = views.filter((v) => v.policyFired.length === 0);
  if (!supported(fired, quiet)) {
    return {
      findings: [],
      skipped: fired.length === 0
        ? "no PolicyEvaluated events in scope"
        : `only ${fired.length} conversations had a rule fire (need ${MIN_SUPPORT})`,
    };
  }

  const byRule = new Map<string, LeadView[]>();
  for (const v of fired) bucket(byRule, v.policyFired[0]!, v);

  const findings: Finding[] = [];
  for (const [rule, vs] of byRule) {
    if (vs.length < MIN_SUPPORT) continue;
    const disengaged = vs.filter((v) => v.repliedAfterPolicy === false).length / vs.length;
    const { ci, diff } = split(quiet, vs);
    if (spans(ci)) continue;

    // Lead with whichever effect is real. Opening on "0.0% never hear from the
    // lead again" reads as a non-finding even when the conversion gap is the
    // reason the finding cleared the bar at all.
    const silences = disengaged > 0.2;
    findings.push({
      code: "policy_friction",
      severity: disengaged > 0.5 ? "high" : "medium",
      claim: silences
        ? `"${rule}" fires in ${vs.length} conversations and ${pct(disengaged)} of them ` +
          `never hear from the lead again.`
        : `"${rule}" fires in ${vs.length} conversations, and those convert ` +
          `${pct(Math.abs(diff))} ${diff > 0 ? "better" : "worse"} than ones where no rule fired.`,
      detail: silences
        ? `they convert ${pct(Math.abs(diff))} ${diff > 0 ? "better" : "worse"} than ` +
          `conversations where no rule fired (95% CI ${pct(ci[0])} .. ${pct(ci[1])})`
        : `${pct(disengaged)} of them go silent afterwards, so the cost is the outcome ` +
          `rather than the conversation ending (95% CI ${pct(ci[0])} .. ${pct(ci[1])})`,
      n: vs.length + quiet.length,
      effect: Math.abs(diff),
      ci95: ci,
      suggestion: `Handle "${rule}" with a branch in the journey rather than an escalation, ` +
                  `so the conversation continues instead of stopping.`,
      evidence: { rule, fired: vs.length, disengagedRate: disengaged },
    });
  }
  return { findings };
};

/** Version v underperforms v-1. */
export const versionRegression: Detector = (views) => {
  const versions = [...new Set(views.map((v) => v.journeyVersion))].sort((a, b) => a - b);
  if (versions.length < 2) return { findings: [], skipped: "only one journey version in scope" };

  const findings: Finding[] = [];
  for (let i = 1; i < versions.length; i++) {
    const prev = views.filter((v) => v.journeyVersion === versions[i - 1]);
    const curr = views.filter((v) => v.journeyVersion === versions[i]);
    if (!supported(prev, curr)) continue;

    const { ra, rb, diff, ci } = split(prev, curr);
    if (spans(ci) || diff >= 0) continue;

    findings.push({
      code: "version_regression",
      severity: "high",
      claim: `v${versions[i]} converts ${pct(Math.abs(diff))} worse than v${versions[i - 1]}.`,
      detail: `${pct(rb)} vs ${pct(ra)} (n=${curr.length} / ${prev.length}), ` +
              `95% CI ${pct(ci[0])} .. ${pct(ci[1])}`,
      n: prev.length + curr.length,
      effect: Math.abs(diff),
      ci95: ci,
      suggestion: `Diff v${versions[i - 1]} against v${versions[i]} and roll back the change ` +
                  `that moved the score, or re-run the A/B before promoting further.`,
      evidence: { from: versions[i - 1], to: versions[i], fromRate: ra, toRate: rb },
    });
  }
  return { findings };
};

/**
 * The agent and the journey disagree about the job.
 *
 * Only reachable for an open-strategy version. The planner proposes, the guardrail
 * disposes, and both halves are on the record — so the rate at which a proposal is
 * refused is measurable, and so is which rule does the refusing.
 *
 * This is the finding that makes non-determinism operable rather than merely
 * interesting. A guardrail that never fires is decoration. One that fires on a
 * third of turns is telling you something specific: either the agent is reaching
 * for something the journey should permit, or the journey is briefed for a
 * conversation the agent is not having. The rule name says which.
 *
 * Conversion is deliberately NOT the headline here. An override changes a single
 * turn, and attributing an outcome to it would be a claim the data cannot carry.
 * The rate and its cause are the finding; the conversion gap is reported beside it
 * with an interval, for the reader to weigh.
 */
export const strategyFriction: Detector = (all) => {
  const open = all.filter((v) => v.moves.length > 0);
  if (open.length === 0) {
    return { findings: [], skipped: "no open-strategy conversations in scope" };
  }
  if (open.length < MIN_SUPPORT) {
    return {
      findings: [],
      skipped: `only ${open.length} open-strategy conversations (need ${MIN_SUPPORT})`,
    };
  }

  const decisions = open.flatMap((v) => v.moves);
  const overridden = decisions.filter((m) => m.overridden);
  if (overridden.length === 0) {
    // Worth saying rather than staying silent: "the guardrail never fired" is a
    // result, and a reader who sees nothing cannot tell it from a broken detector.
    return {
      findings: [],
      skipped:
        `the guardrail admitted all ${decisions.length} decisions across ` +
        `${open.length} conversations — nothing was refused`,
    };
  }

  const byRule = new Map<string, typeof overridden>();
  for (const m of overridden) bucket(byRule, m.rule ?? "(unnamed)", m);

  // The rule doing most of the refusing, because a list of seven small rates is
  // not something anyone acts on.
  const [rule, hits] = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
  const rate = overridden.length / decisions.length;
  const share = hits.length / overridden.length;
  const wanted = [...new Set(hits.map((m) => m.proposed))].join(", ");

  // Conversations where the agent was refused at least once, against the rest.
  const refusedIn = open.filter((v) => v.moves.some((m) => m.overridden));
  const clean = open.filter((v) => !v.moves.some((m) => m.overridden));
  const comparable = supported(refusedIn, clean);
  const { ci, diff } = comparable ? split(clean, refusedIn) : { ci: undefined, diff: 0 };

  return {
    findings: [{
      code: "strategy_friction",
      severity: rate > 0.3 ? "high" : rate > 0.15 ? "medium" : "low",
      claim:
        `The agent's chosen move was refused on ${pct(rate)} of turns, and ` +
        `${pct(share)} of those were "${rule}".`,
      detail:
        `${overridden.length} of ${decisions.length} decisions across ${open.length} ` +
        `conversations were overridden. Under "${rule}" the agent was reaching for: ` +
        `${wanted}.` +
        (comparable && ci
          ? ` Conversations where it was refused at least once convert ` +
            `${pct(Math.abs(diff))} ${diff > 0 ? "better" : "worse"} than ones where it was ` +
            `not (95% CI ${pct(ci[0])} .. ${pct(ci[1])}) — an override changes one turn, so ` +
            `read that as context rather than cause.`
          : ` Too few conversations in one of the two groups to compare conversion.`),
      n: open.length,
      effect: rate,
      ...(comparable && ci ? { ci95: ci } : {}),
      suggestion: suggestFor(rule, wanted),
      evidence: {
        decisions: decisions.length,
        overridden: overridden.length,
        byRule: Object.fromEntries([...byRule].map(([r, ms]) => [r, ms.length])),
      },
    }],
  };
};

/**
 * What to change, per rule. Two directions are always available — permit the
 * thing, or brief the agent so it stops asking — and which one is right depends on
 * the rule, so this says which rather than offering both every time.
 */
function suggestFor(rule: string, wanted: string): string {
  switch (rule) {
    case "answer_without_knowledge":
      return "Leads are asking things no `knowledge:` entry covers, and the agent is " +
             "deflecting instead of answering. Read the transcripts, and declare the facts " +
             "you are happy for it to give word for word.";
    case "close_without_required_evidence":
      return "The agent keeps trying to end conversations early. Either a required field " +
             "is one leads will not give, or the contract is longer than the conversation " +
             "supports — consider making the weakest field optional.";
    case "close_before_all_collected":
      return "The agent keeps trying to stop before it has asked for the optional fields " +
             "this journey collects. If those fields are not worth the extra turns, set " +
             "`objective.collect: required` and lower the qualifying threshold to what the " +
             "required fields can actually reach.";
    case "deflections_exhausted":
      return "The agent is spending its whole budget being agreeable. Raise " +
             "`strategy.max_deflections` if the conversations read well, or declare the " +
             "facts it keeps needing so a deflection becomes an answer.";
    case "ask_already_established":
      return "The agent is asking for things it already has, which usually means the " +
             "extraction is landing at a confidence the contract rejects. Check " +
             "`confidence_min` on the fields it repeats.";
    case "ask_repeated":
      return "Leads are not answering one field in words the journey can place, so the " +
             "agent keeps asking. Loosen that field's options or its `confidence_min`, make " +
             "it optional if leads genuinely do not know, or give it a clearer description.";
    case "ask_sensitive_too_early":
      return "The agent opens with a `sensitive` field. If that is acceptable for this " +
             "vertical, drop the flag; otherwise leave it — the guardrail is doing its job.";
    case "offer_without_privilege":
    case "offer_without_binding":
      return `The agent wants to use a tool it cannot reach (${wanted}). Grant the ` +
             "privilege under `agent.privileges` and declare the binding under `tools:`, " +
             "or remove `offer` from the permitted moves.";
    case "answer_quoted_a_figure":
      return "The agent keeps putting figures in its own framing. That is `quote_exact_fees` " +
             "working as intended — the declared fact still reaches the lead.";
    default:
      return `Review why "${rule}" fires so often: either permit what the agent is ` +
             `reaching for (${wanted}), or change the journey so it stops reaching for it.`;
  }
}

export const DETECTORS: Record<FindingCode, Detector> = {
  evidence_bottleneck: evidenceBottleneck,
  segment_divergence: segmentDivergence,
  drop_off: dropOff,
  routing_miscalibration: routingMiscalibration,
  timing,
  policy_friction: policyFriction,
  version_regression: versionRegression,
  strategy_friction: strategyFriction,
};

function hourIn(at: Date, tz: string): number {
  try {
    // hourCycle h23 explicitly: `hour12: false` yields "24" for midnight under
    // some ICU builds, which would fall outside every bucket.
    const h = Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", hourCycle: "h23",
    }).format(at));
    return Number.isFinite(h) ? h % 24 : at.getUTCHours();
  } catch {
    return at.getUTCHours();
  }
}
