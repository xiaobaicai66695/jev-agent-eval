#!/usr/bin/env node
/** SQLite-backed, blind Jev comparison for multiple agent evaluation standards. */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assignRubric, getAgent, getRubricForAgent, openDatabase, recordEvaluation, upsertAgent, upsertRubric } from "./storage.js";

const MODEL = "typesafe/jev";
const ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
const DEFAULT_DATABASE = "data/agent-eval.sqlite";
type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
type CheckStatus = "pass" | "fail" | "not_run";
type VariantName = "variant_a" | "variant_b";

export interface Variant { artifact: JsonValue; evidence?: JsonObject; metrics?: JsonObject }
export interface AgentEvalCase {
  case_id: string;
  task: { objective: string; acceptance_criteria: string[] };
  deterministic_checks: Array<{ id: string; baseline: CheckStatus; candidate: CheckStatus; required_for_keep: boolean }>;
  baseline: Variant;
  candidate: Variant;
}
export interface RubricProfile {
  id: string;
  name: string;
  criteria: string[];
  minimum_choice_confidence: number;
  maximum_human_review_probability: number;
}
interface JevAnswer { choice?: unknown; confidence?: unknown; score?: unknown; noul?: unknown }
interface JevResponse { answers?: Record<string, JevAnswer>; [key: string]: unknown }
interface BlindPair { seed: string; candidate_variant: VariantName; variants: Record<VariantName, Variant> }
interface GateResult { passed: boolean; failed_checks: string[] }
export interface EvaluationDecision {
  status: "dry_run" | "deterministic_reject" | "completed";
  verdict: "keep" | "revert" | "human_review" | null;
  winner: "baseline" | "candidate" | "tie" | "inconclusive" | null;
  choice_confidence: number | null;
  baseline_task_fulfillment: number | null;
  candidate_task_fulfillment: number | null;
  human_review_probability: number | null;
  reasons: string[];
}
export class InputError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function string(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new InputError(`${field} must be a non-empty string`); return value.trim(); }
function strings(value: unknown, field: string): string[] { if (!Array.isArray(value) || !value.length) throw new InputError(`${field} must be a non-empty array of strings`); return value.map((item, index) => string(item, `${field}[${index}]`)); }
function object(value: unknown, field: string): Record<string, unknown> { if (!isObject(value)) throw new InputError(`${field} must be an object`); return value; }
function probability(value: unknown, field: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new InputError(`${field} must be a number from 0 through 1`); return value; }
function hasOwn(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }

export function validateCase(value: unknown): asserts value is AgentEvalCase {
  const input = object(value, "input");
  string(input.case_id, "case_id");
  const task = object(input.task, "task");
  string(task.objective, "task.objective");
  strings(task.acceptance_criteria, "task.acceptance_criteria");
  if (!Array.isArray(input.deterministic_checks)) throw new InputError("deterministic_checks must be an array");
  input.deterministic_checks.forEach((raw, index) => {
    const check = object(raw, `deterministic_checks[${index}]`);
    string(check.id, `deterministic_checks[${index}].id`);
    for (const side of ["baseline", "candidate"] as const) if (!["pass", "fail", "not_run"].includes(check[side] as string)) throw new InputError(`deterministic_checks[${index}].${side} must be pass, fail, or not_run`);
    if (typeof check.required_for_keep !== "boolean") throw new InputError(`deterministic_checks[${index}].required_for_keep must be boolean`);
  });
  for (const side of ["baseline", "candidate"] as const) {
    const variant = object(input[side], side);
    if (!hasOwn(variant, "artifact")) throw new InputError(`${side}.artifact is required (null is allowed)`);
    if (variant.evidence !== undefined && !isObject(variant.evidence)) throw new InputError(`${side}.evidence must be an object`);
    if (variant.metrics !== undefined && !isObject(variant.metrics)) throw new InputError(`${side}.metrics must be an object`);
  }
}

export function validateRubric(value: unknown): asserts value is RubricProfile {
  const rubric = object(value, "rubric");
  string(rubric.id, "rubric.id");
  string(rubric.name, "rubric.name");
  strings(rubric.criteria, "rubric.criteria");
  probability(rubric.minimum_choice_confidence, "rubric.minimum_choice_confidence");
  probability(rubric.maximum_human_review_probability, "rubric.maximum_human_review_probability");
}

export function evaluateDeterministicGate(input: AgentEvalCase): GateResult {
  const failed_checks = input.deterministic_checks.filter((check) => check.required_for_keep && check.candidate !== "pass").map((check) => check.id);
  return { passed: !failed_checks.length, failed_checks };
}

export function blindPair(input: AgentEvalCase, suppliedSeed?: string): BlindPair {
  const seed = suppliedSeed ?? randomUUID();
  const candidate_variant: VariantName = createHash("sha256").update(`${input.case_id}:${seed}`).digest()[0]! % 2 === 0 ? "variant_a" : "variant_b";
  const variants = candidate_variant === "variant_a" ? { variant_a: structuredClone(input.candidate), variant_b: structuredClone(input.baseline) } : { variant_a: structuredClone(input.baseline), variant_b: structuredClone(input.candidate) };
  return { seed, candidate_variant, variants };
}

function variantToJson(variant: Variant): JsonObject {
  const result: JsonObject = { artifact: variant.artifact };
  if (variant.evidence) result.evidence = variant.evidence;
  if (variant.metrics) result.metrics = variant.metrics;
  return result;
}

export function buildJevRequest(input: AgentEvalCase, rubric: RubricProfile, pair: BlindPair): JsonObject {
  const scoreCriteria = ["未满足：未达到关键验收标准或有重大错误", "部分满足：达到部分标准，但有明显遗漏或风险", "充分满足：达到验收标准且没有证据显示明显回归"];
  return { model: MODEL, input: { state: {
    task: input.task,
    rubric: rubric.criteria,
    deterministic_check_results: input.deterministic_checks.map(({ id, baseline, candidate }) => ({ id, variant_a: pair.candidate_variant === "variant_a" ? candidate : baseline, variant_b: pair.candidate_variant === "variant_b" ? candidate : baseline })),
    variant_a: variantToJson(pair.variants.variant_a), variant_b: variantToJson(pair.variants.variant_b),
    judging_boundary: "只根据提供的任务、标准、产物、证据和指标进行比较；不得假设未提供的事实。variant_a 与 variant_b 没有优先级。",
  }, questions: {
    preferred_variant: { type: "choice", instructions: "依据验收标准和 rubric，哪个 variant 的结果更好？若无实质差异选 tie；若证据不足以公平比较选 inconclusive。", criteria: { variant_a: "variant_a 明显更符合任务、验收标准和 rubric", variant_b: "variant_b 明显更符合任务、验收标准和 rubric", tie: "两者在现有证据下没有实质质量差异", inconclusive: "证据不足或矛盾，无法做可靠比较" } },
    variant_a_task_fulfillment: { type: "score", instructions: "variant_a 对任务验收标准的完成程度如何？", criteria: scoreCriteria },
    variant_b_task_fulfillment: { type: "score", instructions: "variant_b 对任务验收标准的完成程度如何？", criteria: scoreCriteria },
    needs_human_audit: { type: "noul", instructions: "在保留或回滚此修改前，是否需要人工审计？", criteria: { true: "结果有关键不确定性、证据冲突、或可能存在未覆盖的重大回归", false: "现有证据足以进行常规 benchmark 决策" } },
  } } };
}

function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function answer(response: JevResponse, key: string): JevAnswer { const result = response.answers?.[key]; if (!result) throw new Error(`Jev response is missing ${key}`); return result; }

export function deriveDecision(response: JevResponse | null, input: AgentEvalCase, rubric: RubricProfile, pair: BlindPair, gate: GateResult): EvaluationDecision {
  if (!gate.passed) return { status: "deterministic_reject", verdict: "revert", winner: null, choice_confidence: null, baseline_task_fulfillment: null, candidate_task_fulfillment: null, human_review_probability: null, reasons: gate.failed_checks.map((id) => `required_check_failed:${id}`) };
  if (!response) return { status: "dry_run", verdict: null, winner: null, choice_confidence: null, baseline_task_fulfillment: null, candidate_task_fulfillment: null, human_review_probability: null, reasons: ["dry_run: model was not called"] };
  const selected = answer(response, "preferred_variant").choice;
  const aScore = number(answer(response, "variant_a_task_fulfillment").score);
  const bScore = number(answer(response, "variant_b_task_fulfillment").score);
  const choiceConfidence = number(answer(response, "preferred_variant").confidence);
  const auditProbability = number(answer(response, "needs_human_audit").noul);
  if (typeof selected !== "string" || !["variant_a", "variant_b", "tie", "inconclusive"].includes(selected)) throw new Error("Jev returned an invalid preferred_variant");
  if (aScore === null || bScore === null || aScore < 0 || aScore > 2 || bScore < 0 || bScore > 2) throw new Error("Jev returned an invalid task fulfillment score");
  if (choiceConfidence === null || choiceConfidence < 0 || choiceConfidence > 1) throw new Error("Jev returned an invalid choice confidence");
  if (auditProbability === null || auditProbability < 0 || auditProbability > 1) throw new Error("Jev returned an invalid human-audit probability");
  const candidateScore = pair.candidate_variant === "variant_a" ? aScore : bScore;
  const baselineScore = pair.candidate_variant === "variant_a" ? bScore : aScore;
  const winner: EvaluationDecision["winner"] = selected === pair.candidate_variant ? "candidate" : selected === (pair.candidate_variant === "variant_a" ? "variant_b" : "variant_a") ? "baseline" : selected === "tie" ? "tie" : "inconclusive";
  const reasons: string[] = [];
  if (choiceConfidence < rubric.minimum_choice_confidence) reasons.push("choice_confidence_below_rubric_minimum");
  if (auditProbability > rubric.maximum_human_review_probability) reasons.push("human_audit_probability_above_rubric_maximum");
  if (winner === "candidate" && candidateScore < baselineScore) reasons.push("candidate_score_below_baseline_score");
  const automatic = choiceConfidence >= rubric.minimum_choice_confidence && auditProbability <= rubric.maximum_human_review_probability;
  const verdict = winner === "candidate" && candidateScore >= baselineScore && automatic ? "keep" : winner === "baseline" && automatic ? "revert" : "human_review";
  return { status: "completed", verdict, winner, choice_confidence: choiceConfidence, baseline_task_fulfillment: baselineScore, candidate_task_fulfillment: candidateScore, human_review_probability: auditProbability, reasons };
}

async function readJson(path: string): Promise<unknown> { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { throw new InputError(`cannot read valid JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`); } }
async function loadApiToken(): Promise<string> { const path = resolve(import.meta.dirname, "..", "auth.txt"); let token: string; try { token = (await readFile(path, "utf8")).trim(); } catch { throw new InputError(`API token not found. Create ${path} from auth.txt.example.`); } if (!token || token === "YOUR_CLOUDFLARE_API_TOKEN") throw new InputError(`${path} must contain a Cloudflare API token`); return token; }
async function callJev(requestBody: JsonObject, accountId: string, token: string, timeoutMs: number): Promise<JevResponse> {
  let response: Response; try { response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(requestBody), signal: AbortSignal.timeout(timeoutMs) }); } catch (error) { throw new Error(`Jev request failed: ${error instanceof Error ? error.message : String(error)}`); }
  const body: unknown = await response.json().catch(() => null); if (!response.ok) throw new Error(`Jev request failed with HTTP ${response.status}: ${JSON.stringify(body)}`); if (!isObject(body)) throw new Error("Jev returned a non-object JSON response"); if (body.success === false) throw new Error(`Cloudflare rejected the request: ${JSON.stringify(body)}`); return (isObject(body.result) ? body.result : body) as JevResponse;
}
function metric(value: number | null): string { return value === null ? "—" : value.toFixed(2); }
function artifactName(caseId: string): string { const slug = caseId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "agent-eval"; return `${new Date().toISOString().replace(/[-:.]/g, "")}-${slug.slice(0, 48)}`; }
async function writeArtifacts(outputDir: string, caseInput: AgentEvalCase, artifact: JsonObject): Promise<{ json: string; markdown: string }> {
  await mkdir(outputDir, { recursive: true }); const name = artifactName(caseInput.case_id); const json = join(outputDir, `${name}.json`); const markdown = join(outputDir, `${name}.md`);
  const decision = artifact.decision as unknown as EvaluationDecision; const rubric = artifact.rubric as unknown as RubricProfile;
  const report = `# Agent Evaluation Audit\n\n- Agent: ${artifact.agent_id}\n- Rubric: ${rubric.id}\n- Case: ${caseInput.case_id}\n- Verdict: ${decision.verdict ?? "—"}\n- Winner: ${decision.winner ?? "—"}\n- Choice confidence: ${metric(decision.choice_confidence)}\n- Baseline fulfillment: ${metric(decision.baseline_task_fulfillment)} / 2\n- Candidate fulfillment: ${metric(decision.candidate_task_fulfillment)} / 2\n- Human audit probability: ${metric(decision.human_review_probability)}\n\n## Reasons\n\n${decision.reasons.map((reason) => `- ${reason}`).join("\n")}\n`;
  await writeFile(json, `${JSON.stringify(artifact, null, 2)}\n`, "utf8"); await writeFile(markdown, report, "utf8"); return { json, markdown };
}

type Command = "init-db" | "upsert-rubric" | "upsert-agent" | "assign-rubric" | "validate" | "evaluate";
interface Args { command: Command; database: string; input?: string; file?: string; agentId?: string; agentName?: string; rubricId?: string; dryRun: boolean; accountId?: string; timeoutMs: number; outputDir: string; seed?: string }
function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv; if (!(["init-db", "upsert-rubric", "upsert-agent", "assign-rubric", "validate", "evaluate"] as string[]).includes(command ?? "")) throw new InputError("usage: agent_eval <init-db|upsert-rubric|upsert-agent|assign-rubric|validate|evaluate> [options]");
  const values = new Map<string, string | boolean>(); const valued = ["--database", "--input", "--file", "--agent-id", "--name", "--rubric-id", "--account-id", "--timeout", "--output-dir", "--seed"];
  for (let index = 0; index < rest.length; index += 1) { const flag = rest[index]; if (flag === "--dry-run") { values.set(flag, true); continue; } if (!valued.includes(flag ?? "")) throw new InputError(`unknown argument: ${flag}`); const value = rest[index + 1]; if (!value || value.startsWith("--")) throw new InputError(`${flag} requires a value`); values.set(flag!, value); index += 1; }
  const get = (flag: string): string | undefined => typeof values.get(flag) === "string" ? values.get(flag) as string : undefined;
  const seconds = get("--timeout") === undefined ? 30 : Number(get("--timeout")); if (!Number.isFinite(seconds) || seconds <= 0) throw new InputError("--timeout must be a positive number of seconds");
  return { command: command as Command, database: get("--database") ?? DEFAULT_DATABASE, input: get("--input"), file: get("--file"), agentId: get("--agent-id"), agentName: get("--name"), rubricId: get("--rubric-id"), dryRun: values.get("--dry-run") === true, accountId: get("--account-id"), timeoutMs: seconds * 1_000, outputDir: get("--output-dir") ?? "artifacts", seed: get("--seed") };
}
function requireArg(value: string | undefined, flag: string): string { if (!value) throw new InputError(`${flag} is required`); return value; }

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv); const database = openDatabase(args.database);
    try {
      if (args.command === "init-db") { console.log(JSON.stringify({ status: "initialized", database: args.database }, null, 2)); return 0; }
      if (args.command === "upsert-rubric") { const rubric = await readJson(requireArg(args.file, "--file")); validateRubric(rubric); upsertRubric(database, rubric); console.log(JSON.stringify({ status: "saved", rubric_id: rubric.id }, null, 2)); return 0; }
      if (args.command === "upsert-agent") { const id = requireArg(args.agentId, "--agent-id"); upsertAgent(database, id, args.agentName ?? id); console.log(JSON.stringify({ status: "saved", agent_id: id }, null, 2)); return 0; }
      if (args.command === "assign-rubric") { assignRubric(database, requireArg(args.agentId, "--agent-id"), requireArg(args.rubricId, "--rubric-id")); console.log(JSON.stringify({ status: "assigned", agent_id: args.agentId, rubric_id: args.rubricId }, null, 2)); return 0; }
      const agentId = requireArg(args.agentId, "--agent-id"); const input = await readJson(requireArg(args.input, "--input")); validateCase(input); const agent = getAgent(database, agentId); if (!agent) throw new InputError(`agent not found: ${agentId}`); const rubric = getRubricForAgent(database, agentId); validateRubric(rubric); const gate = evaluateDeterministicGate(input);
      if (args.command === "validate") { console.log(JSON.stringify({ status: "valid", agent, rubric_id: rubric.id, deterministic_gate: gate }, null, 2)); return 0; }
      const pair = blindPair(input, args.seed); const request = buildJevRequest(input, rubric, pair); const response = !gate.passed || args.dryRun ? null : await callJev(request, args.accountId ?? process.env[ACCOUNT_ID_ENV] ?? (() => { throw new InputError(`provide --account-id or set ${ACCOUNT_ID_ENV}`); })(), await loadApiToken(), args.timeoutMs); const decision = deriveDecision(response, input, rubric, pair, gate);
      const audit: JsonObject = { schema_version: 2, evaluation_id: randomUUID(), generated_at: new Date().toISOString(), agent_id: agentId, rubric: rubric as unknown as JsonValue, case: input as unknown as JsonValue, deterministic_gate: gate as unknown as JsonValue, blind_assignment: { seed: pair.seed, candidate_variant: pair.candidate_variant }, jev_request: request, raw_model_response: response as unknown as JsonValue, decision: decision as unknown as JsonValue };
      const paths = await writeArtifacts(args.outputDir, input, audit); recordEvaluation(database, { id: audit.evaluation_id as string, agentId, rubricId: rubric.id, caseId: input.case_id, status: decision.status, verdict: decision.verdict, audit }); console.log(JSON.stringify({ status: decision.status, verdict: decision.verdict, winner: decision.winner, rubric_id: rubric.id, json_artifact: paths.json, markdown_artifact: paths.markdown }, null, 2)); return decision.verdict === "revert" && decision.status === "deterministic_reject" ? 2 : 0;
    } finally { database.close(); }
  } catch (error) { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); return 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
