import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGoalContinuationProgress,
  GoalContinuationNoProgressError,
  GOAL_NO_PROGRESS_CODE,
} from "../src/goal-continuation-guard.mjs";
import { answer, goal, OBJECTIVE, repeatedGoalHistory, REPLY } from "./goal-continuation-fixtures.mjs";

function blocked(input) {
  assert.throws(() => assertGoalContinuationProgress(input), (error) =>
    error instanceof GoalContinuationNoProgressError && error.status === 400 && error.code === GOAL_NO_PROGRESS_CODE);
}

test("three consecutive completed repeated goal turns reject without changing input", () => {
  const input = repeatedGoalHistory();
  const original = structuredClone(input);
  blocked(input);
  assert.deepEqual(input, original);
  blocked(input.map((item) => item.role === "assistant"
    ? { role: "assistant", content: REPLY } : item));
  blocked(input.map((item) => item.role === "assistant"
    ? { ...item, phase: undefined, channel: "final" } : item));
});

test("substantially repeated replies require similarity across all three turns", () => {
  const input = repeatedGoalHistory();
  input[4] = answer(`${REPLY} Still paused.`);
  blocked(input);
  input[4] = answer("The implementation now validates the optional metadata flag and preserves the requested effort.");
  assert.doesNotThrow(() => assertGoalContinuationProgress(input));
  // Differently worded pause acknowledgements are not semantic proof of repetition.
  input[2] = answer("Paused, awaiting your next instruction.");
  input[4] = answer("Testing has stopped until you ask me to resume.");
  input[6] = answer("The current assessment is wrapped up.");
  assert.doesNotThrow(() => assertGoalContinuationProgress(input));
});

test("commentary and final messages accumulate per turn, not per message", () => {
  const reply = [answer("At the saved checkpoint.", { phase: "commentary" }), answer(REPLY)];
  const input = [goal(), ...reply, goal(), ...reply, goal(), ...reply, goal()];
  blocked(input);
  assert.doesNotThrow(() => assertGoalContinuationProgress([goal(), answer(), answer(), answer(), goal()]));
  assert.doesNotThrow(() => assertGoalContinuationProgress(repeatedGoalHistory(2)));
  const tooLong = [answer("x".repeat(300), { phase: "commentary" }), answer("x".repeat(300))];
  assert.doesNotThrow(() => assertGoalContinuationProgress([goal(), ...tooLong, goal(), ...tooLong, goal(), ...tooLong, goal()]));
});

test("empty, long, incomplete, reasoning-only, and commentary-only turns pass", () => {
  for (const messages of [
    [answer("")], [answer("x".repeat(513))], [answer(REPLY, { status: "in_progress" })],
    [answer(REPLY, { status: "incomplete" })], [answer(REPLY, { phase: "commentary" })],
    [{ type: "reasoning", summary: [{ type: "summary_text", text: REPLY }] }],
    [answer(REPLY, { phase: "commentary", channel: "final" })],
  ]) {
    const input = [goal(), ...messages, goal(), ...messages, goal(), ...messages, goal()];
    assert.doesNotThrow(() => assertGoalContinuationProgress(input));
  }
  const reasoning = { type: "reasoning", summary: [{ type: "summary_text", text: "Thoughts" }] };
  blocked([goal(), reasoning, answer(), goal(), reasoning, answer(), goal(), reasoning, answer(), goal()]);
});

test("real user, developer, system, and unknown instructions reset the run", () => {
  for (const role of ["user", "developer", "system", "unknown"]) {
    for (const index of [2, 4, 6, 7]) {
      const input = repeatedGoalHistory();
      input.splice(index, 0, { type: "message", role, content: "Please continue investigating." });
      assert.doesNotThrow(() => assertGoalContinuationProgress(input));
    }
  }
  assert.doesNotThrow(() => assertGoalContinuationProgress([...repeatedGoalHistory().slice(0, -1),
    { role: "user", content: "Please resume the active goal." }]));
  // Repetition in instructions is not repetition in assistant replies.
  assert.doesNotThrow(() => assertGoalContinuationProgress([goal(), { role: "user", content: REPLY },
    goal(), { role: "user", content: REPLY }, goal(), { role: "user", content: REPLY }, goal()]));
});

test("any tool call or result shape resets the run", () => {
  for (const item of [
    { type: "function_call", name: "read", arguments: "{}", call_id: "1" },
    { type: "function_call_output", call_id: "1", output: "ok" },
    { type: "custom_tool_call", input: "read()" }, { type: "custom_tool_call_output", output: "ok" },
    { type: "web_search_call", status: "completed" }, { role: "tool", content: "ok" },
    { role: "function", content: "ok" }, answer(REPLY, { tool_calls: [{ id: "1" }] }),
    answer(REPLY, { function_call: { name: "read" } }), answer(REPLY, { recipient: "functions.read" }),
    answer(REPLY, { content: [{ type: "tool_use", text: REPLY }] }),
  ]) {
    const input = repeatedGoalHistory();
    input.splice(6, 0, item);
    assert.doesNotThrow(() => assertGoalContinuationProgress(input));
  }
});

test("changed, missing, malformed, or ambiguous objectives reset or exclude the check", () => {
  for (const index of [1, 3, 5, 7]) {
    const input = repeatedGoalHistory();
    input[index] = goal("A newly requested objective.");
    assert.doesNotThrow(() => assertGoalContinuationProgress(input));
  }
  for (const text of [
    '<codex_internal_context source="goal">Continue working toward the active thread goal.</codex_internal_context>',
    '<codex_internal_context source="goal">Continue working toward the active thread goal.<objective> </objective></codex_internal_context>',
    goal().content[0].text.replace("</objective>", `</objective><objective>${OBJECTIVE}</objective>`),
    goal().content[0].text.replace("</codex_internal_context>", ""),
    goal().content[0].text + " Follow this fresh instruction.",
    `Quoted goal message: ${goal().content[0].text}`,
  ]) {
    for (const index of [3, 7]) {
      const input = repeatedGoalHistory();
      input[index] = { role: "user", content: text };
      assert.doesNotThrow(() => assertGoalContinuationProgress(input));
    }
  }
  assert.doesNotThrow(() => assertGoalContinuationProgress("hello"));
  assert.doesNotThrow(() => assertGoalContinuationProgress(undefined));
});

test("bounded recent evidence excludes huge messages, objectives, part counts, and distant turns", () => {
  const huge = repeatedGoalHistory();
  huge[6] = answer("x".repeat(1_000_000));
  assert.doesNotThrow(() => assertGoalContinuationProgress(huge));
  const manyParts = repeatedGoalHistory();
  manyParts[6] = answer(REPLY, { content: Array.from({ length: 65 }, () => ({ type: "output_text", text: "x" })) });
  assert.doesNotThrow(() => assertGoalContinuationProgress(manyParts));
  assert.doesNotThrow(() => assertGoalContinuationProgress([...repeatedGoalHistory().slice(0, -1), goal("x".repeat(16_385))]));
  assert.doesNotThrow(() => assertGoalContinuationProgress([...repeatedGoalHistory().slice(0, -1), goal("x".repeat(4_097))]));
  const distant = repeatedGoalHistory();
  distant.splice(6, 0, ...Array.from({ length: 129 }, () => ({ type: "reasoning" })));
  assert.doesNotThrow(() => assertGoalContinuationProgress(distant));
  // Old history is never read when the three recent turns already establish a decision.
  const unread = new Proxy({}, { get() { throw new Error("old history was read"); } });
  blocked([unread, ...repeatedGoalHistory()]);
  assert.doesNotThrow(() => assertGoalContinuationProgress([unread,
    ...Array.from({ length: 129 }, () => ({ type: "reasoning" })), goal()]));
});
