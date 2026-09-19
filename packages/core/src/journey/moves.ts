/**
 * The repertoire an open-strategy agent chooses from.
 *
 * A scripted journey has exactly one move available to it — ask for the next
 * missing field — and `nextField()` chooses the subject in code. That is why a
 * lead who asks a question gets a question back: the runtime has no way to
 * express "answer them first".
 *
 * Naming the repertoire is what makes the non-determinism reviewable. The model
 * picks from this closed set and says why; it does not emit free-form intent. So
 * every conversation reduces to a sequence of named moves that a person can read
 * and a detector can count, rather than to prose nobody can audit.
 */
export const MOVES = ["ask", "answer", "acknowledge", "offer", "close", "escalate"] as const;

export type Move = (typeof MOVES)[number];

/**
 * What each move means, in the words the planner is given and the console shows.
 * One definition, so the prompt and the UI cannot drift into describing
 * different behaviour.
 */
export const MOVE_INTENT: Record<Move, string> = {
  ask: "Ask for one piece of evidence that is still missing.",
  answer: "Answer a question the lead asked, using ONLY a declared knowledge entry.",
  acknowledge:
    "Respond to what the lead said without asking for anything — reassurance, " +
    "an objection handled, a tangent closed off — then hand the turn back.",
  offer: "Use a tool on the lead's behalf: look something up, book, or write to the CRM.",
  close: "Stop collecting and finish the conversation: score, route, done.",
  escalate: "Hand to a human now.",
};

/**
 * Why a proposed move was not performed.
 *
 * These are the interesting rows in the log. A guardrail that never fires is
 * decoration; one that fires constantly means the journey and the agent disagree
 * about the job, which is a finding rather than a bug.
 */
export const OVERRIDE_RULES = [
  "move_not_permitted",
  "close_without_required_evidence",
  "answer_without_knowledge",
  "answer_quoted_a_figure",
  "ask_unknown_field",
  "ask_already_established",
  "ask_sensitive_too_early",
  "ask_repeated",
  "offer_without_privilege",
  "offer_without_binding",
  "deflections_exhausted",
  "empty_message",
] as const;

export type OverrideRule = (typeof OVERRIDE_RULES)[number];

/** One sentence per rule, for the console and the finding text. */
export const OVERRIDE_REASON: Record<OverrideRule, string> = {
  move_not_permitted: "the journey does not allow that move",
  close_without_required_evidence: "required evidence is still missing",
  answer_without_knowledge: "no declared knowledge entry covers that question",
  answer_quoted_a_figure: "the framing contained a figure and this journey may not quote them",
  ask_unknown_field: "the field asked for is not in the evidence contract",
  ask_already_established: "that field is already established",
  ask_sensitive_too_early: "a sensitive field cannot be the first thing asked",
  ask_repeated: "that field has been asked for as often as the journey allows and the answer did not land",
  offer_without_privilege: "the agent holds no privilege for that capability",
  offer_without_binding: "the journey declares no tool for that capability",
  deflections_exhausted: "the agent had already deflected as often as the journey permits",
  empty_message: "the planner returned nothing to send",
};
