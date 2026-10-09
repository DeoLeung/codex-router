export const OBJECTIVE = "Implement the requested fix and verify the result.";
export const REPLY = "Work is paused at the saved checkpoint. No additional progress was made in this turn.";

export function goal(objective = OBJECTIVE) {
  return { type: "message", role: "user", content: [{ type: "input_text", text:
    `<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n<objective>${objective}</objective>\n</codex_internal_context>` }] };
}

export function answer(text = REPLY, extra = {}) {
  return { type: "message", role: "assistant", status: "completed", phase: "final_answer",
    content: [{ type: "output_text", text }], ...extra };
}

export function repeatedGoalHistory(turns = 3) {
  const input = [{ role: "user", content: "Please fix the problem." }];
  for (let i = 0; i < turns; i++) input.push(goal(), answer());
  return [...input, goal()];
}
