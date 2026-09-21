import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assignRubric, getRubricForAgent, openDatabase, upsertAgent, upsertRubric } from "../src/storage.js";
import { blindPair, buildJevRequest, deriveDecision, evaluateDeterministicGate, main, validateCase, validateRubric, type AgentEvalCase, type RubricProfile } from "../src/agent_eval.js";

const root = resolve(import.meta.dirname, "..", "..");
const caseInput = JSON.parse(await readFile(join(root, "examples", "cases", "support-answer-format-v1.json"), "utf8")) as AgentEvalCase;
const rubric = JSON.parse(await readFile(join(root, "examples", "rubrics", "support-quality-v1.json"), "utf8")) as RubricProfile;

async function temporaryDatabase(): Promise<string> { return join(await mkdtemp(join(tmpdir(), "jev-agent-eval-")), "eval.sqlite"); }

test("an agent resolves to its own SQLite rubric", async () => {
  const path = await temporaryDatabase();
  const database = openDatabase(path);
  try {
    validateRubric(rubric);
    upsertRubric(database, rubric);
    upsertAgent(database, "support-agent", "Support Agent");
    assignRubric(database, "support-agent", rubric.id);
    assert.deepEqual(getRubricForAgent(database, "support-agent"), rubric);
  } finally { database.close(); }
});

test("blind request hides baseline and candidate roles", () => {
  validateCase(caseInput);
  const request = buildJevRequest(caseInput, rubric, blindPair(caseInput, "fixed-seed"));
  const state = request.state as Record<string, unknown>;
  assert.ok(state.variant_a);
  assert.ok(state.variant_b);
  assert.equal("baseline" in state, false);
  assert.equal("candidate" in state, false);
});

test("a failed deterministic requirement rejects before judging", () => {
  const failing = structuredClone(caseInput);
  failing.deterministic_checks[0]!.candidate = "fail";
  const gate = evaluateDeterministicGate(failing);
  const decision = deriveDecision(null, failing, rubric, blindPair(failing, "fixed-seed"), gate);
  assert.equal(decision.verdict, "revert");
  assert.equal(decision.status, "deterministic_reject");
});

test("a blind Jev winner maps back to the candidate", () => {
  const pair = blindPair(caseInput, "fixed-seed");
  const response = { answers: {
    preferred_variant: { choice: pair.candidate_variant, confidence: 0.9 },
    variant_a_task_fulfillment: { score: pair.candidate_variant === "variant_a" ? 2 : 1 },
    variant_b_task_fulfillment: { score: pair.candidate_variant === "variant_b" ? 2 : 1 },
    needs_human_audit: { noul: 0.1 }
  } };
  const decision = deriveDecision(response, caseInput, rubric, pair, evaluateDeterministicGate(caseInput));
  assert.equal(decision.winner, "candidate");
  assert.equal(decision.verdict, "keep");
});

test("evaluate uses the rubric assigned to agent ID and records dry run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-agent-eval-"));
  const database = join(directory, "eval.sqlite");
  const output = join(directory, "artifacts");
  assert.equal(await main(["upsert-rubric", "--database", database, "--file", join(root, "examples", "rubrics", "support-quality-v1.json")]), 0);
  assert.equal(await main(["upsert-agent", "--database", database, "--agent-id", "support-agent", "--name", "Support Agent"]), 0);
  assert.equal(await main(["assign-rubric", "--database", database, "--agent-id", "support-agent", "--rubric-id", rubric.id]), 0);
  assert.equal(await main(["evaluate", "--database", database, "--agent-id", "support-agent", "--input", join(root, "examples", "cases", "support-answer-format-v1.json"), "--dry-run", "--seed", "fixed-seed", "--output-dir", output]), 0);
  const file = (await readdir(output)).find((name) => name.endsWith(".json"));
  assert.ok(file);
  const audit = JSON.parse(await readFile(join(output, file), "utf8")) as { agent_id: string; rubric: { id: string }; raw_model_response: unknown };
  assert.equal(audit.agent_id, "support-agent");
  assert.equal(audit.rubric.id, rubric.id);
  assert.equal(audit.raw_model_response, null);
});
