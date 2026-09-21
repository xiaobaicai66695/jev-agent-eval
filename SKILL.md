---
name: jev-agent-eval
description: Score benchmark cases and compare an anonymous baseline/candidate pair using an Agent ID's SQLite-backed rubric and Jev typed judgments. Use for agent, prompt, memory, tool-policy, or code-change evaluation; do not use it as the only correctness or safety check.
---

# Jev agent evaluation

Use this skill to run auditable before/after Agent evaluations. Each Agent ID is assigned a default rubric in a local SQLite registry, so different Agents can have different scoring standards without embedding a rubric in every case file.

- A case supplies the task, acceptance criteria, deterministic-check results, and two artifacts.
- A rubric supplies quality criteria and automatic-decision thresholds.
- `src/agent_eval.ts` rejects a candidate that fails a required deterministic check before calling Jev.
- Jev receives anonymous `variant_a` and `variant_b`, then returns a typed winner, fulfillment score for each variant, and human-audit probability.

## Workflow

1. Create a rubric JSON matching `examples/rubrics/support-quality-v1.json` and a case JSON matching `examples/cases/support-answer-format-v1.json`.
2. Build and register the rubric, Agent ID, and assignment. The default registry is `data/agent-eval.sqlite`; use `--database <path>` to isolate environments.

   ```powershell
   npm install
   npm run build
   node dist/src/agent_eval.js upsert-rubric --file examples/rubrics/support-quality-v1.json
   node dist/src/agent_eval.js upsert-agent --agent-id support-agent --name "Support Agent"
   node dist/src/agent_eval.js assign-rubric --agent-id support-agent --rubric-id support-quality-v1
   ```

3. Validate and dry-run a case. `--seed` makes the A/B assignment reproducible.

   ```powershell
   node dist/src/agent_eval.js validate --agent-id support-agent --input examples/cases/support-answer-format-v1.json
   node dist/src/agent_eval.js evaluate --agent-id support-agent --input examples/cases/support-answer-format-v1.json --dry-run --seed demo-001
   ```

4. For a live evaluation, put only the Cloudflare API token in `auth.txt`, then provide `--account-id` or `CLOUDFLARE_ACCOUNT_ID`.

## Package the CLI

Run `npm run package` to generate an installable `.tgz`; the `prepack` hook compiles TypeScript first. Install that file globally with `npm install -g <package-file>`, then use `jev-agent-eval evaluate ...` instead of `node dist/src/agent_eval.js evaluate ...`.

The SQLite database stores Agent/rubric assignments and an audit record indexed by Agent ID, rubric ID, and case ID. JSON and Markdown artifacts are written under ignored `artifacts/`. Neither storage location contains the API key. Historical records retain the rubric snapshot used for that evaluation.

## Boundaries

- Do not let Jev override compilation, tests, budget caps, security checks, or other deterministic gates.
- Do not use the same benchmark cases to optimize an Agent and to claim final quality. Keep a holdout set with human labels or objective outcomes.
- Randomize or counterbalance A/B order across repeated runs. Do not label variants “candidate”, “new”, or “optimized” in evidence sent to Jev.
- Treat `tie`, `inconclusive`, and `human_review` as valid outcomes.
