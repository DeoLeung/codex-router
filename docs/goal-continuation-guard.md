# Opt-in automatic goal continuation protection

Set `"goalContinuationGuard": true` on a routed model entry to refuse an
automatic Codex goal continuation after three consecutive completed goal turns
whose non-empty replies are short and substantially repeated, with no tool
activity. Omission or `false` keeps the existing behavior. The boolean is
supported in checked-in model metadata and `user-models.json`, including custom
GLM models; the model family alone never enables it. Restart the router after
editing a user model entry so it loads the setting.
For a checked-in model, set the flag in a registry override
(`MODEL_ROUTER_REGISTRY`); a duplicate user-model entry does not override its
metadata. No shipped model enables the guard.

The gate reads the original Responses input before conversion or a provider
generation request. Compaction requests are excluded. It recognizes only a user message containing the canonical
`<codex_internal_context source="goal">` wrapper, its automatic continuation
instruction, and one non-empty `<objective>`. The three preceding completed
goal turns must have the same objective. Commentary and final messages are
combined within each turn; three messages in one turn do not count as three
turns. Explicit commentary alone and incomplete messages do not establish a
completed turn. Unphased assistant messages closed by the next goal continuation
are accepted for clients whose transcript omits phase metadata.

A fresh user, developer, or system instruction, any tool call/result, changed or
ambiguous objective, empty reply, distinct reply, or combined reply longer than
512 characters excludes the recent sequence. The scan is bounded to 128 recent
items, 64 content parts per message, and 16,384 characters per goal context
(4,096 per objective). Evidence exceeding a bound passes through. This is a
conservative repetition heuristic, not a general measure of useful progress.

A refusal returns HTTP 400 with `invalid_request_error` and code
`router_goal_no_progress`, records one failed request in the existing usage
ledger, and makes no provider request, retry, or failover. It asks the operator
to review the saved state and resume with a fresh instruction. The router
neither rewrites the transcript nor modifies Codex's goal database or marks a
goal complete/blocked. Effort, tools, and provider options remain governed by
the existing request path. Native traffic has no model flag and is unaffected.

Regression checks:

```sh
node --test test/goal-continuation-guard.test.mjs test/goal-continuation-registry.test.mjs test/goal-continuation-router.test.mjs
npm run check
```
