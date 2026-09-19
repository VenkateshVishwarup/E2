/**
 * Switching a journey between the deterministic and non-deterministic strategies
 * from the editor, by editing its YAML.
 *
 * A structural rewrite (parse → mutate → serialise) would reformat the whole
 * document and throw away the comments, which in this spec carry most of the
 * reasoning. So these are surgical text edits on the two blocks that matter, and
 * everything the author wrote survives untouched.
 *
 * The safety net is the lint endpoint, which re-parses on every keystroke: a bad
 * edit is visible immediately rather than at publish time. These functions are
 * still tested line by line, because "the lint will catch it" is not a reason to
 * be careless with someone's spec.
 */
export type StrategyKind = "scripted" | "open";

interface Block { start: number; end: number }

/**
 * The line range of a top-level block, or null.
 *
 * A block runs from its key to the next line at column zero. Trailing blank and
 * comment lines are handed back to the FOLLOWING block: a comment sitting above
 * `policy:` explains policy, and swallowing it into the block before would move
 * it when that block is replaced.
 */
function findBlock(lines: readonly string[], key: string): Block | null {
  const start = lines.findIndex((l) => new RegExp(`^${key}:(?:\\s|$)`).test(l));
  if (start === -1) return null;

  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!))) end++;

  let trimmed = end;
  while (trimmed > start + 1) {
    const prev = lines[trimmed - 1]!;
    if (prev.trim() === "" || /^\s*#/.test(prev)) trimmed--;
    else break;
  }
  return { start, end: trimmed };
}

/** Which strategy the YAML declares. Absent means scripted, as the schema says. */
export function readStrategy(yaml: string): StrategyKind {
  const lines = yaml.split("\n");
  const block = findBlock(lines, "strategy");
  if (!block) return "scripted";
  for (let i = block.start; i < block.end; i++) {
    if (/^\s+kind:\s*open\b/.test(lines[i]!)) return "open";
  }
  return "scripted";
}

export function hasKnowledge(yaml: string): boolean {
  const lines = yaml.split("\n");
  const block = findBlock(lines, "knowledge");
  if (!block) return false;
  // `knowledge: {}` declares the block and no facts, which is what the schema
  // default already gives you. Treat it as absent so the toggle offers a starter.
  if (/^knowledge:\s*\{\s*\}\s*$/.test(lines[block.start]!)) return false;
  return block.end > block.start + 1;
}

const SCRIPTED_BLOCK = [
  "strategy:",
  "  # The runtime walks the evidence contract in a fixed order and the model only",
  "  # writes the wording of a question whose subject was already chosen in code.",
  "  kind: scripted",
];

const OPEN_BLOCK = [
  "strategy:",
  "  # The model chooses the next move and says why; the guardrail then admits the",
  "  # choice or overrides it. The path is non-deterministic. What the agent is",
  "  # PERMITTED to do is not.",
  "  kind: open",
  "  moves: [ask, answer, acknowledge, offer, close, escalate]",
  "  # A model that finds a conversation awkward reaches for the exit, and an early",
  "  # close is indistinguishable in the log from a lead who answered everything.",
  "  allow_unscripted_close: false",
  "  # Turns in a row it may spend not collecting anything. Every one is billed.",
  "  max_deflections: 2",
  "  reasoning_effort: medium",
];

const KNOWLEDGE_STARTER = [
  "# The only facts the agent may state, sent verbatim. It decides WHETHER to",
  "# answer; this block decides WHAT the answer says. Anything not here, it admits",
  "# it does not know — which is what makes an open agent shippable.",
  "knowledge:",
  "  example_topic: >-",
  "    Replace this with something a lead actually asks, and the answer you are",
  "    happy for the agent to give word for word.",
];

/**
 * Where a new block goes: just before `policy:`, which every spec has and which
 * reads naturally after the strategy. Falling back to the end of the document
 * keeps this total rather than throwing on an unusual spec.
 */
function insertionPoint(lines: readonly string[]): number {
  const policy = findBlock(lines, "policy");
  return policy ? policy.start : lines.length;
}

/** Replaces the `strategy:` block, or inserts one. Leaves everything else alone. */
export function setStrategy(yaml: string, kind: StrategyKind): string {
  const lines = yaml.split("\n");
  const block = kind === "open" ? OPEN_BLOCK : SCRIPTED_BLOCK;
  const existing = findBlock(lines, "strategy");

  const next = existing
    ? [...lines.slice(0, existing.start), ...block, ...lines.slice(existing.end)]
    : insert(lines, insertionPoint(lines), [...block, ""]);

  return next.join("\n");
}

/**
 * Adds a starter `knowledge:` block when there is none.
 *
 * Called when switching to open, because an open journey that may answer and has
 * no facts declared is exactly the `unanswerable_open_journey` warning — better
 * to hand someone a block to fill in than a warning to decode.
 */
export function ensureKnowledge(yaml: string): string {
  if (hasKnowledge(yaml)) return yaml;
  const lines = yaml.split("\n");
  const empty = findBlock(lines, "knowledge");
  const starter = [...KNOWLEDGE_STARTER, ""];

  // `knowledge: {}` is replaced in place rather than duplicated.
  if (empty) return [...lines.slice(0, empty.start), ...starter, ...lines.slice(empty.end)].join("\n");
  return insert(lines, insertionPoint(lines), starter).join("\n");
}

function insert(lines: readonly string[], at: number, what: readonly string[]): string[] {
  return [...lines.slice(0, at), ...what, ...lines.slice(at)];
}

/** The whole switch, as the editor performs it. */
export function switchStrategy(yaml: string, kind: StrategyKind): string {
  const withStrategy = setStrategy(yaml, kind);
  return kind === "open" ? ensureKnowledge(withStrategy) : withStrategy;
}
