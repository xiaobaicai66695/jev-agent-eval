---
name: jev-agent-eval
description: Score a single Agent result or compare an anonymous baseline/candidate pair using the Agent ID's SQLite-backed rubric and Jev typed judgments. Use for agent, prompt, memory, tool-policy, or code-change evaluation; do not use it as the only correctness or safety check.
---

# Jev agent evaluation

Use the SQLite registry to assign each Agent ID its own rubric. Choose the mode based on the actual question; never force a single-result score into an A/B comparison or use a relative comparison as an absolute leaderboard score.

| Need | Command | Input shape | Result |
| --- | --- | --- | --- |
| How well did one result satisfy its task? | `score` | `subject`, one status per deterministic check | fulfillment score, score confidence, human-audit probability |
| Should a candidate replace a baseline? | `compare` | `baseline`, `candidate`, status for each side | `keep`, `revert`, or `human_review` |

`compare` anonymizes variants before calling Jev and does not ask for absolute scores. `score` sends only one subject and does not select a winner. Required deterministic checks always run first and cannot be waived by Jev.

## Setup

Create a rubric and register the Agent once:

```powershell
npm install
npm run build
node dist/src/agent_eval.js upsert-rubric --file examples/rubrics/support-quality-v1.json
node dist/src/agent_eval.js upsert-agent --agent-id support-agent --name "Support Agent"
node dist/src/agent_eval.js assign-rubric --agent-id support-agent --rubric-id support-quality-v1
```

## Score one result

Use when the result needs an absolute benchmark score, independent of any prior version.

```powershell
node dist/src/agent_eval.js score --agent-id support-agent --input examples/cases/support-answer-score-v1.json --dry-run
```

## Compare two versions

Use only when deciding whether the candidate should replace the baseline.

```powershell
node dist/src/agent_eval.js compare --agent-id support-agent --input examples/cases/support-answer-format-v1.json --dry-run --seed demo-001
```

For a live call, put only the TypeSafe API key in root `auth.txt`; no account ID is required. The registry defaults to ignored `data/agent-eval.sqlite`; artifacts are stored under ignored `artifacts/`. Each record stores `evaluation_type` (`score` or `compare`) and the rubric snapshot it used.

## Boundaries

- Do not let Jev override compilation, tests, budget caps, security checks, or other deterministic gates.
- Keep optimization and holdout benchmark sets separate.
- Treat `tie`, `inconclusive`, and `human_review` as valid compare outcomes.
