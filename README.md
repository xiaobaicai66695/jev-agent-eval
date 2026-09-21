# Jev Agent Eval

> 用 [Jev](https://docs.typesafe.ai/introduction) 对 Agent benchmark 做**单项评分**，或对新旧产物做**匿名对比**。两种评测是独立的工作流。

[English](#english) · [中文](#中文)

## 中文

`jev-agent-eval` 用 SQLite 将每个 Agent ID 绑定到相应的、版本化评分标准（rubric）。调用时根据问题选择模式：想知道一个结果本身完成得如何，用 `score`；只在需要决定候选修改是否替换基线时，用 `compare`。

```text
                           ┌─ score ───→ 绝对完成度分数 + 置信度
Agent ID ─→ SQLite rubric ─┤
                           └─ compare ─→ 匿名 A/B 的 keep / revert / human_review
```

`score` 只发送一个 `subject`，不会产生赢家；`compare` 将基线和候选匿名为 A/B，仅判断相对优劣，不产生绝对分数。两者都先执行确定性检查，Jev 不能越过这些硬门槛。

### 数据模型

| 表 | 用途 |
| --- | --- |
| `agents` | Agent ID、显示名和当前默认 rubric |
| `rubrics` | 版本化评分标准与对比决策阈值 |
| `evaluations` | 评测历史、`evaluation_type` 与不可变审计快照 |

重分配 Agent 的 rubric 不会改写历史；每次记录会保存当时使用的 rubric 快照和模式。

### 快速开始

要求 Node.js 20+。

```powershell
npm install
npm test
npm run build

# 注册 rubric 与 Agent；首次运行会创建 data/agent-eval.sqlite
node dist/src/agent_eval.js upsert-rubric --file examples/rubrics/support-quality-v1.json
node dist/src/agent_eval.js upsert-agent --agent-id support-agent --name "Support Agent"
node dist/src/agent_eval.js assign-rubric --agent-id support-agent --rubric-id support-quality-v1
```

单项评分（适合 benchmark 成绩、回归趋势和多 Agent 横向统计）：

```powershell
node dist/src/agent_eval.js score --agent-id support-agent --input examples/cases/support-answer-score-v1.json --dry-run
```

新旧对比（只适合“是否保留这次修改”的决策）：

```powershell
node dist/src/agent_eval.js compare --agent-id support-agent --input examples/cases/support-answer-format-v1.json --dry-run --seed demo-001
```

可在不调用模型的前提下检查输入与硬门槛；需要明确模式以避免误用另一种 case 契约：

```powershell
node dist/src/agent_eval.js validate --mode score --agent-id support-agent --input examples/cases/support-answer-score-v1.json
node dist/src/agent_eval.js validate --mode compare --agent-id support-agent --input examples/cases/support-answer-format-v1.json
```

真实调用时，将 TypeSafe API Key 放进未提交的根目录 `auth.txt`，然后去掉 `--dry-run`。默认数据库为 `data/agent-eval.sqlite`，可通过 `--database <path>` 覆盖；数据库、审计产物和 Key 均不会提交到 Git。

### 打包为 CLI

发布前先创建 npm 包；`prepack` 会自动编译 TypeScript：

```powershell
npm run package
npm install -g .\jev-agent-eval-0.1.0.tgz
```

安装后使用 `jev-agent-eval score ...` 或 `jev-agent-eval compare ...`。

### 输入与边界

- [`examples/cases/support-answer-score-v1.json`](examples/cases/support-answer-score-v1.json) 是单项 `score` case：一个 `subject`，检查项使用 `required_for_score`。
- [`examples/cases/support-answer-format-v1.json`](examples/cases/support-answer-format-v1.json) 是 `compare` case：`baseline` 与 `candidate`，检查项使用 `required_for_keep`。
- `compare` 中候选未通过必需检查时直接 `revert`，不会调用 Jev；`score` 中必需检查未通过时结果为 `invalid`。
- 匿名对比中，`variant_a` / `variant_b` 不透露基线/候选角色；`--seed` 可复现映射。
- `tie`、`inconclusive`、`human_review` 都是有效的对比结果。优化集与 holdout 集必须分离，并用人类标签或客观结果校准 Jev。

## English

`jev-agent-eval` binds each Agent ID to a versioned SQLite rubric. Pick the workflow from the question: use `score` for the intrinsic quality of one result; use `compare` only to decide whether a candidate should replace a baseline.

```text
                           ┌─ score ───→ absolute fulfillment score + confidence
Agent ID ──→ SQLite rubric ┤
                           └─ compare ─→ blind A/B keep / revert / human_review
```

`score` sends one `subject` and never selects a winner. `compare` blinds the baseline and candidate, asks only for a relative choice, and never emits an absolute score. Deterministic checks run before either Jev call and cannot be overridden.

### SQLite model

| Table | Purpose |
| --- | --- |
| `agents` | Agent ID, display name, and current default rubric |
| `rubrics` | Versioned criteria and comparison decision thresholds |
| `evaluations` | Evaluation history, `evaluation_type`, and immutable audit snapshots |

### Quick start

Requires Node.js 20+.

```powershell
npm install
npm test
npm run build
node dist/src/agent_eval.js upsert-rubric --file examples/rubrics/support-quality-v1.json
node dist/src/agent_eval.js upsert-agent --agent-id support-agent --name "Support Agent"
node dist/src/agent_eval.js assign-rubric --agent-id support-agent --rubric-id support-quality-v1

# Absolute score for one result
node dist/src/agent_eval.js score --agent-id support-agent --input examples/cases/support-answer-score-v1.json --dry-run

# Blind decision about a proposed replacement
node dist/src/agent_eval.js compare --agent-id support-agent --input examples/cases/support-answer-format-v1.json --dry-run --seed demo-001
```

For validation without a model call, use `validate --mode score` or `validate --mode compare` with the matching input. For a live call, put a TypeSafe API key in untracked root `auth.txt` and remove `--dry-run`. Use `--database <path>` for another SQLite registry; the default database, artifacts, and key are ignored by Git.

### Package as a CLI

```powershell
npm run package
npm install -g .\jev-agent-eval-0.1.0.tgz
```

After installation, run `jev-agent-eval score ...` or `jev-agent-eval compare ...`.

### Safeguards

- The score input contains one `subject` and `required_for_score` checks; the compare input contains `baseline` and `candidate` with `required_for_keep` checks.
- A failed required comparison check reverts the candidate without a model call. A failed required scoring check produces an invalid score.
- `compare` never tells Jev which anonymous variant is the baseline or candidate. `--seed` makes the mapping reproducible.
- Treat `tie`, `inconclusive`, and `human_review` as first-class comparison outcomes. Keep optimization and holdout sets separate, and calibrate Jev against human labels or objective outcomes.

## Development

```powershell
npm test
```

## License

No license has been selected yet. Add one before publishing for reuse.
