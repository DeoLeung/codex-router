import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_BY_SLUG } from "../src/model-registry.mjs";

// Facts from platform.claude.com/docs/en/models/overview and
// .../build-with-claude/effort: every 5.x model has a 1M window, text and image
// input, adaptive thinking, and the full low..max effort ladder. Only the
// default effort differs.
const ANTHROPIC_5_5 = [
  { id: "opus-5.5", upstream: "claude-opus-5-5", defaultEffort: "medium" },
  { id: "fable-5.1", upstream: "claude-fable-5-1", defaultEffort: "high" },
  { id: "sonnet-5.5", upstream: "claude-sonnet-5-5", defaultEffort: "high" },
  { id: "haiku-5.5", upstream: "claude-haiku-5-5", defaultEffort: "medium" },
];

for (const provider of ["anthropic-api"]) {
  test(`${provider} ships the Claude 5.x line with documented capabilities`, () => {
    for (const { id, upstream, defaultEffort } of ANTHROPIC_5_5) {
      const slug = `${provider}/claude-${id}`;
      const model = MODEL_BY_SLUG.get(slug);
      assert.ok(model, `${slug} is registered`);
      assert.equal(model.upstreamModel, upstream, slug);
      assert.equal(model.provider, provider, slug);
      assert.equal(model.requestProfile, "anthropic-reasoning", slug);
      assert.equal(model.defaultEffort, defaultEffort, slug);
      assert.deepEqual(
        model.reasoningLevels.map((level) => level.effort),
        ["low", "medium", "high", "xhigh", "max"],
        slug,
      );
      assert.deepEqual(model.inputModalities, ["text", "image"], slug);
      assert.equal(model.contextWindow, 1_000_000, slug);
      assert.ok(model.autoCompact < model.contextWindow, `${slug} compacts before the window fills`);
    }
  });

  test(`${provider} lists the 5.x line ahead of Opus 4.8`, () => {
    const opus48 = MODEL_BY_SLUG.get(`${provider}/claude-opus-4.8`);
    assert.ok(opus48);
    for (const { id } of ANTHROPIC_5_5) {
      const model = MODEL_BY_SLUG.get(`${provider}/claude-${id}`);
      assert.ok(model.priority < opus48.priority, `${model.slug} sorts above ${opus48.slug}`);
    }
  });
}
