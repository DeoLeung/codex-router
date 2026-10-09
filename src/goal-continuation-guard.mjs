// This opt-in gate reads only the recent supplied transcript. It neither edits
// history nor owns Codex's goal state. Ambiguous or over-bound evidence passes.
const MAX_HISTORY_ITEMS = 128;
const MAX_CONTENT_PARTS = 64;
const MAX_GOAL_CHARS = 16_384;
const MAX_OBJECTIVE_CHARS = 4_096;
const MAX_REPLY_CHARS = 512;
const REQUIRED_TURNS = 3;

export const GOAL_NO_PROGRESS_CODE = "router_goal_no_progress";

export class GoalContinuationNoProgressError extends Error {
  constructor() {
    super("Stopped automatic goal continuation after three repeated replies without tool activity. Review the saved state and resume with a new user instruction.");
    this.name = "GoalContinuationNoProgressError";
    this.status = 400;
    this.code = GOAL_NO_PROGRESS_CODE;
  }
}

function toolActivity(item) {
  return item?.role === "tool" || item?.role === "function" ||
    item?.tool_call_id !== undefined || item?.call_id !== undefined ||
    item?.function_call !== undefined ||
    (item?.recipient !== undefined && item.recipient !== "all") ||
    (item?.tool_calls !== undefined &&
      (!Array.isArray(item.tool_calls) || item.tool_calls.length > 0));
}

// Check lengths before copying or normalizing: a single enormous message or a
// many-part message must not turn this optional heuristic into an unbounded scan.
function boundedText(item, maxChars) {
  if (typeof item?.content === "string") {
    return item.content.length <= maxChars ? item.content : undefined;
  }
  if (!Array.isArray(item?.content) || item.content.length > MAX_CONTENT_PARTS) return undefined;
  let text = "";
  for (const part of item.content) {
    if (!part || !["text", "input_text", "output_text"].includes(part.type) ||
      typeof part.text !== "string" || toolActivity(part)) return undefined;
    const separator = text ? "\n" : "";
    if (text.length + separator.length + part.text.length > maxChars) return undefined;
    text += separator + part.text;
  }
  return text;
}

function goalObjective(item) {
  if (item?.role !== "user" || (item.type && item.type !== "message") || toolActivity(item) ||
    (item.status !== undefined && item.status !== "completed")) return undefined;
  const text = boundedText(item, MAX_GOAL_CHARS);
  if (text === undefined ||
    !/^\s*<codex_internal_context source="goal">\s*Continue working toward the active thread goal\./.test(text) ||
    !/<\/codex_internal_context>\s*$/.test(text)) return undefined;
  // Exactly one wrapper and objective. Duplicate, nested, missing, and empty
  // objectives cannot establish that these turns belong to the same goal.
  if ((text.match(/<\/?codex_internal_context\b/g) || []).length !== 2 ||
    (text.match(/<\/?objective\b/g) || []).length !== 2) return undefined;
  const objective = text.match(/<objective>([\s\S]*?)<\/objective>/)?.[1]?.trim();
  return objective && objective.length <= MAX_OBJECTIVE_CHARS ? objective : undefined;
}

function substantiallyRepeated(left, right) {
  const normalize = (text) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return true;
  // Similar tiny acknowledgements are too little evidence unless identical.
  if (Math.min(a.length, b.length) < 24) return false;
  const shingles = (text) => {
    const values = new Set();
    for (let i = 0; i + 3 <= text.length; i++) values.add(text.slice(i, i + 3));
    return values;
  };
  const first = shingles(a);
  const second = shingles(b);
  let shared = 0;
  for (const value of first) if (second.has(value)) shared++;
  return shared / Math.max(first.size, second.size) >= 0.8;
}

export function assertGoalContinuationProgress(input) {
  if (!Array.isArray(input)) return;
  const objective = goalObjective(input.at(-1));
  if (!objective) return;
  const replies = [];
  let reply = "";
  let completed = false;
  const firstIndex = Math.max(0, input.length - 1 - MAX_HISTORY_ITEMS);
  for (let index = input.length - 2; index >= firstIndex; index--) {
    const item = input[index];
    if (!item || toolActivity(item) ||
      (item.status !== undefined && item.status !== "completed")) return;
    if (item.type === "reasoning") {
      // Reasoning is neither a completed reply nor a tool result. A role on it
      // must still not hide a fresh instruction from this backward scan.
      if (item.role !== undefined && item.role !== "assistant") return;
      continue;
    }
    if (item.type && item.type !== "message") return;
    if (item.role === "user") {
      if (goalObjective(item) !== objective || !completed || !reply.trim()) return;
      replies.push(reply);
      if (replies.length === REQUIRED_TURNS) {
        if (substantiallyRepeated(replies[0], replies[1]) &&
          substantiallyRepeated(replies[1], replies[2]) &&
          substantiallyRepeated(replies[0], replies[2])) throw new GoalContinuationNoProgressError();
        return;
      }
      reply = "";
      completed = false;
      continue;
    }
    // Any fresh user, system, developer, or unknown item resets the run.
    if (item.role !== "assistant") return;
    if (item.phase !== undefined && !["commentary", "final_answer"].includes(item.phase)) return;
    if (item.channel !== undefined && !["commentary", "final"].includes(item.channel)) return;
    if ((item.phase === "commentary" && item.channel === "final") ||
      (item.phase === "final_answer" && item.channel === "commentary")) return;
    const text = boundedText(item, MAX_REPLY_CHARS - reply.length);
    if (text === undefined) return;
    const separator = reply && text ? "\n" : "";
    if (text.length + separator.length + reply.length > MAX_REPLY_CHARS) return;
    reply = text + separator + reply;
    // Unphased messages in a transcript closed by the next goal marker also
    // represent completed turns. Explicit commentary alone does not.
    if (item.phase === "final_answer" || item.channel === "final" ||
      (item.phase === undefined && item.channel === undefined)) completed = true;
  }
}
