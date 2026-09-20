/**
 * The same lead, twice: once through the scripted strategy, once through the open one.
 *
 * No database and no OPENAI_API_KEY. The point is not the quality of the prose —
 * offline, both strategies write plainly — it is WHERE the two transcripts
 * diverge, and what the guardrail did at each divergence. Every decision printed
 * here is a `MoveChosen` event in a real run, which is why the same divergence is
 * measurable later instead of only visible now.
 *
 * With a credential, drop `OfflinePlanner` and the same code runs the real thing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isOpen, parseSpec, pinnedDefaults, renderPinned, type JourneySpec,
} from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import { AgentRuntime } from "@midfunnel/runtime/step";
import { OfflinePlanner } from "@midfunnel/runtime/planner";
import { KeywordExtractor } from "@midfunnel/runtime/keyword-extractor";
import { offlineClient } from "@midfunnel/runtime/offline-client";
import { actionsToEvents } from "@midfunnel/runtime/persist";
import { hasCredential, loadEnvFile } from "@midfunnel/runtime/provider";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../packages/core/test/fixtures");

/**
 * A lead who behaves the way leads actually behave: opens with a question,
 * answers two things at once, asks three things nobody can answer, and only then
 * gives up the sensitive field.
 *
 * The budget line names the declared band because the offline extractor reads
 * enum vocabulary and nothing else. A model-backed extractor reads "about ten
 * lakh"; this one would not, and the demo should fail for interesting reasons
 * rather than that one.
 */
const LEAD = [
  "Hi — what are the scholarships like?",
  "Executive MBA, and I want to start this intake.",
  "Will I definitely get in if I apply?",
  "And is parking available on campus?",
  "One more — do you have a hostel?",
  "Somewhere in the 5L to 15L range, and I decide myself.",
];

interface Line { who: string; text: string; note?: string }

async function converse(spec: JourneySpec, says: readonly string[]): Promise<Line[]> {
  // Pinned text is a template until someone renders it, and that someone is
  // normally ChatService. Doing it here too, so the transcript reads as a lead
  // would see it rather than as raw braces.
  const vars = { name: "Priya", ...pinnedDefaults(spec) };
  // The offline planner and extractor keep this runnable anywhere. Both are
  // materially weaker than the model-backed versions; the control flow is not.
  const rt = new AgentRuntime(new KeywordExtractor() as never, offlineClient(), new OfflinePlanner());
  const state: LeadState = {
    leadId: "demo", journey: spec.journey, journeyVersion: spec.version,
    evidence: {}, turns: [], outcomes: [], moves: [],
  };
  const base = {
    leadId: "demo", journey: spec.journey,
    journeyVersion: spec.version, agentId: spec.agent.identity,
  };
  const out: Line[] = [];

  for (let i = 0; i <= says.length; i++) {
    const applied = actionsToEvents(
      await rt.step(spec, state, { allowFollowUp: true, toolsAvailable: true }), base, "web",
    );

    const note = applied.move
      ? (applied.move.overridden
          ? `${applied.move.proposed} → ${applied.move.move}  [${applied.move.rule}]`
          : applied.move.move)
      : undefined;

    const said = applied.sentText === null ? null : renderPinned(applied.sentText, vars).text;
    if (said) out.push({ who: "agent", text: said, ...(note ? { note } : {}) });
    // A close says nothing, so there is no line to hang the note on — the
    // outcome line right below carries it instead.
    else if (note) out.push({ who: "note", text: note });

    for (const e of applied.events) {
      if (e.type === "EvidenceExtracted") {
        state.evidence[String(e.payload.field)] =
          { value: e.payload.value, confidence: Number(e.payload.confidence) };
      }
      if (e.type === "MoveChosen") {
        state.moves.push({
          move: String(e.payload.move), proposed: String(e.payload.proposed),
          overridden: Boolean(e.payload.overridden), rule: e.payload.rule as string | null,
          rationale: String(e.payload.rationale), at: new Date(),
        });
      }
    }
    if (said) state.turns.push({ role: "agent", text: said, at: new Date() });

    if (applied.escalated) {
      out.push({ who: "end", text: `escalated — ${applied.escalationRule}` });
      return out;
    }
    if (applied.completed) {
      out.push({
        who: "end",
        text: applied.score === null
          ? "ended without a decision"
          : `score ${applied.score} → ${applied.decision}, qualified: ${applied.qualified}`,
      });
      return out;
    }

    const say = says[i];
    if (say === undefined) {
      // Saying WHY it stopped matters: "the lead ran out of script" and "the
      // agent decided it was done" look identical in a transcript and mean
      // opposite things.
      const missing = Object.entries(spec.evidence)
        .filter(([f, d]) => d.required && state.evidence[f] === undefined)
        .map(([f]) => f);
      out.push({
        who: "end",
        text: missing.length > 0
          ? `lead script exhausted, still collecting: ${missing.join(", ")}`
          : "lead script exhausted",
      });
      return out;
    }
    out.push({ who: "lead", text: say });
    state.turns.push({ role: "lead", text: say, at: new Date() });
  }
  return out;
}

function render(title: string, lines: readonly Line[]): void {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
  for (const l of lines) {
    if (l.who === "end") { console.log(`      ▸ ${l.text}`); continue; }
    if (l.who === "note") { console.log(`      · ${l.text}`); continue; }
    if (l.note) console.log(`      · ${l.note}`);
    console.log(`${l.who === "lead" ? "LEAD " : "AGENT"} ${l.text}`);
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  if (hasCredential()) {
    console.log(
      "note: a credential is present but this script uses the offline planner on " +
      "purpose, so its output is reproducible and free.\n",
    );
  }

  const scripted = parseSpec(readFileSync(join(FIXTURES, "mba-v4.yaml"), "utf8"));
  const open = parseSpec(readFileSync(join(FIXTURES, "mba-v8-open.yaml"), "utf8"));
  if (isOpen(scripted) || !isOpen(open)) throw new Error("fixtures are the wrong way round");

  render(`SCRIPTED — v${scripted.version}`, await converse(scripted, LEAD));
  render(`OPEN — v${open.version}`, await converse(open, LEAD));

  console.log(
    "\nSame contract, same scoring, same routing. The only difference is who chose\n" +
    "what happened next — which is why replaying one against the other measures\n" +
    "the strategy and nothing else.",
  );
}

void main();
