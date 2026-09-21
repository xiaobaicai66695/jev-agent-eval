import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RubricProfile } from "./agent_eval.js";

export interface AgentRecord { id: string; displayName: string; rubricId: string | null }

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS rubrics (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      criteria_json TEXT NOT NULL,
      minimum_choice_confidence REAL NOT NULL,
      maximum_human_review_probability REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      rubric_id TEXT REFERENCES rubrics(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      rubric_id TEXT NOT NULL REFERENCES rubrics(id),
      case_id TEXT NOT NULL,
      evaluation_type TEXT NOT NULL DEFAULT 'compare',
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      verdict TEXT,
      audit_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evaluations_agent_case_idx ON evaluations(agent_id, case_id, created_at);
  `);
  const columns = database.prepare("PRAGMA table_info(evaluations)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "evaluation_type")) database.exec("ALTER TABLE evaluations ADD COLUMN evaluation_type TEXT NOT NULL DEFAULT 'compare'");
  return database;
}

export function upsertRubric(database: Database.Database, rubric: RubricProfile): void {
  database.prepare(`INSERT INTO rubrics (id, name, criteria_json, minimum_choice_confidence, maximum_human_review_probability, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, criteria_json = excluded.criteria_json,
      minimum_choice_confidence = excluded.minimum_choice_confidence,
      maximum_human_review_probability = excluded.maximum_human_review_probability, updated_at = excluded.updated_at`)
    .run(rubric.id, rubric.name, JSON.stringify(rubric.criteria), rubric.minimum_choice_confidence, rubric.maximum_human_review_probability, new Date().toISOString());
}

export function upsertAgent(database: Database.Database, id: string, displayName: string): void {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO agents (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`).run(id, displayName, now, now);
}

export function assignRubric(database: Database.Database, agentId: string, rubricId: string): void {
  if (!database.prepare("SELECT 1 FROM rubrics WHERE id = ?").get(rubricId)) throw new Error(`rubric not found: ${rubricId}`);
  const result = database.prepare("UPDATE agents SET rubric_id = ?, updated_at = ? WHERE id = ?").run(rubricId, new Date().toISOString(), agentId);
  if (!result.changes) throw new Error(`agent not found: ${agentId}`);
}

export function getAgent(database: Database.Database, id: string): AgentRecord | null {
  const row = database.prepare("SELECT id, display_name, rubric_id FROM agents WHERE id = ?").get(id) as { id: string; display_name: string; rubric_id: string | null } | undefined;
  return row ? { id: row.id, displayName: row.display_name, rubricId: row.rubric_id } : null;
}

export function getRubricForAgent(database: Database.Database, agentId: string): RubricProfile {
  const row = database.prepare(`SELECT r.id, r.name, r.criteria_json, r.minimum_choice_confidence, r.maximum_human_review_probability
    FROM agents a JOIN rubrics r ON r.id = a.rubric_id WHERE a.id = ?`).get(agentId) as { id: string; name: string; criteria_json: string; minimum_choice_confidence: number; maximum_human_review_probability: number } | undefined;
  if (!row) throw new Error(`agent has no assigned rubric: ${agentId}`);
  return { id: row.id, name: row.name, criteria: JSON.parse(row.criteria_json) as string[], minimum_choice_confidence: row.minimum_choice_confidence, maximum_human_review_probability: row.maximum_human_review_probability };
}

export function recordEvaluation(database: Database.Database, values: { id: string; agentId: string; rubricId: string; caseId: string; evaluationType: "score" | "compare"; status: string; verdict: string | null; audit: unknown }): void {
  database.prepare(`INSERT INTO evaluations (id, agent_id, rubric_id, case_id, evaluation_type, created_at, status, verdict, audit_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(values.id, values.agentId, values.rubricId, values.caseId, values.evaluationType, new Date().toISOString(), values.status, values.verdict, JSON.stringify(values.audit));
}
