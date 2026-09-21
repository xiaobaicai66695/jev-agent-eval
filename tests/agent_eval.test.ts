import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assignRubric, openDatabase, upsertAgent, upsertRubric } from "../src/storage.js";
import { blindPair, buildCompareRequest, buildScoreRequest, deriveCompare, deriveScore, main, validateComparisonCase, validateRubric, validateScoringCase, type ComparisonCase, type RubricProfile, type ScoringCase } from "../src/agent_eval.js";

const root = resolve(import.meta.dirname, "..", "..");
const compareCase = JSON.parse(await readFile(join(root, "examples/cases/support-answer-format-v1.json"), "utf8")) as ComparisonCase;
const scoreCase = JSON.parse(await readFile(join(root, "examples/cases/support-answer-score-v1.json"), "utf8")) as ScoringCase;
const rubric = JSON.parse(await readFile(join(root, "examples/rubrics/support-quality-v1.json"), "utf8")) as RubricProfile;

test("score request contains one subject and no A/B pair", () => {
  validateScoringCase(scoreCase); validateRubric(rubric);
  const state = buildScoreRequest(scoreCase, rubric).state as Record<string, unknown>;
  assert.ok(state.subject); assert.equal("variant_a" in state, false); assert.equal("variant_b" in state, false);
});
test("compare request contains blind pair and no score questions", () => {
  validateComparisonCase(compareCase);
  const request = buildCompareRequest(compareCase, rubric, blindPair(compareCase, "seed"));
  const state = request.state as Record<string, unknown>, questions = request.questions as Record<string, unknown>;
  assert.ok(state.variant_a); assert.ok(state.variant_b); assert.equal("baseline" in state, false); assert.equal("task_fulfillment" in questions, false);
});
test("score derives an absolute score without a comparison verdict", () => {
  const decision = deriveScore({ answers: { task_fulfillment: { score: 1.8, confidence: 0.9 }, needs_human_audit: { noul: 0.1 } } }, { passed: true, failed: [] });
  assert.equal(decision.task_fulfillment, 1.8); assert.equal(decision.outcome, "scored"); assert.equal("verdict" in decision, false);
});
test("compare derives keep from a blind candidate winner", () => {
  const pair = blindPair(compareCase, "seed");
  const decision = deriveCompare({ answers: { preferred_variant: { choice: pair.candidateVariant, confidence: 0.9 }, needs_human_audit: { noul: 0.1 } } }, rubric, pair, { passed: true, failed: [] });
  assert.equal(decision.winner, "candidate"); assert.equal(decision.verdict, "keep");
});
test("CLI independently records score and compare dry runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-agent-eval-")), dbPath = join(dir, "eval.sqlite");
  assert.equal(await main(["upsert-rubric", "--database", dbPath, "--file", join(root, "examples/rubrics/support-quality-v1.json")]), 0);
  assert.equal(await main(["upsert-agent", "--database", dbPath, "--agent-id", "support-agent"]), 0);
  assert.equal(await main(["assign-rubric", "--database", dbPath, "--agent-id", "support-agent", "--rubric-id", rubric.id]), 0);
  assert.equal(await main(["score", "--database", dbPath, "--agent-id", "support-agent", "--input", join(root, "examples/cases/support-answer-score-v1.json"), "--dry-run", "--output-dir", join(dir, "score")]), 0);
  assert.equal(await main(["compare", "--database", dbPath, "--agent-id", "support-agent", "--input", join(root, "examples/cases/support-answer-format-v1.json"), "--dry-run", "--output-dir", join(dir, "compare")]), 0);
});
