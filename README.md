# Jev Agent Eval

> 用 [Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/) 对多个 Agent 的 benchmark 与前后版本改动进行可审计、概率化的 A/B 评测。

[English](#english) · [中文](#中文)

## 中文

`jev-agent-eval` 用 SQLite 把不同的 Agent ID 绑定到不同的评分标准（rubric）。评测 case 只描述任务、验收标准、确定性检查和基线/候选产物；执行时通过 `--agent-id` 自动加载对应的质量准则和决策阈值。

```text
Agent ID ──→ SQLite rubric ──┐
case: baseline + candidate ──┼─→ 确定性检查 ─→ 匿名 A/B Jev 评测
                             │                         │
                             └────────────────── keep / revert / human_review
```

### 数据模型

| 表 | 用途 |
| --- | --- |
| `agents` | Agent ID、显示名和当前默认 rubric |
| `rubrics` | 版本化评分标准与自动决策阈值 |
| `evaluations` | Agent/rubric/case 的评测历史和审计快照 |

重新分配 Agent 的 rubric 不会改写历史：每条评测都会保存当时使用的 rubric 快照。

### 快速开始

要求 Node.js 20+。

```powershell
npm install
npm test
npm run build

# 注册 rubric 与 Agent；首次运行创建 data/agent-eval.sqlite
node dist/src/agent_eval.js upsert-rubric --file examples/rubrics/support-quality-v1.json
node dist/src/agent_eval.js upsert-agent --agent-id support-agent --name "Support Agent"
node dist/src/agent_eval.js assign-rubric --agent-id support-agent --rubric-id support-quality-v1

# 根据 Agent ID 评测 case
node dist/src/agent_eval.js validate --agent-id support-agent --input examples/cases/support-answer-format-v1.json
node dist/src/agent_eval.js evaluate --agent-id support-agent --input examples/cases/support-answer-format-v1.json --dry-run --seed demo-001
```

### 打包为 CLI

发布前先创建 npm 包；`prepack` 会自动编译 TypeScript：

```powershell
npm run package
# 生成 jev-agent-eval-0.1.0.tgz
npm install -g .\jev-agent-eval-0.1.0.tgz
```

安装后可省去 `node dist/src/...` 前缀：

```powershell
jev-agent-eval upsert-rubric --file examples/rubrics/support-quality-v1.json
jev-agent-eval upsert-agent --agent-id support-agent --name "Support Agent"
jev-agent-eval assign-rubric --agent-id support-agent --rubric-id support-quality-v1
jev-agent-eval evaluate --agent-id support-agent --input examples/cases/support-answer-format-v1.json --dry-run
```

真实调用时，在未提交的根目录 `auth.txt` 放 Cloudflare API Token，并提供账户 ID：

```powershell
node dist/src/agent_eval.js evaluate --agent-id support-agent --input examples/cases/support-answer-format-v1.json --account-id <CLOUDFLARE_ACCOUNT_ID>
```

默认 SQLite 数据库为 `data/agent-eval.sqlite`，可用 `--database <path>` 覆盖。数据库、审计产物和 API Key 都不会提交到 Git。

### 输入与边界

- [`examples/rubrics/support-quality-v1.json`](examples/rubrics/support-quality-v1.json) 定义质量准则和阈值。
- [`examples/cases/support-answer-format-v1.json`](examples/cases/support-answer-format-v1.json) 定义任务、确定性检查和 A/B 产物。
- 候选未通过 `required_for_keep` 的检查时直接 `revert`，不会调用 Jev。
- 请求中的 `variant_a` / `variant_b` 不透露基线或候选角色；`--seed` 可复现映射。
- `tie`、`inconclusive`、`human_review` 是正常结果。优化集和 holdout 集必须分离，并应用人类标签或客观结果校准 Jev。

## English

`jev-agent-eval` binds each Agent ID to a scoring rubric in SQLite. A case contains the task, acceptance criteria, deterministic checks, and baseline/candidate artifacts. `--agent-id` loads the correct rubric and decision thresholds at evaluation time.

```text
Agent ID ──→ SQLite rubric ──┐
case: baseline + candidate ──┼─→ deterministic gates ─→ blind A/B Jev judgment
                             │                              │
                             └────────────────────── keep / revert / human_review
```

### SQLite model

| Table | Purpose |
| --- | --- |
| `agents` | Agent ID, display name, and default rubric |
| `rubrics` | Versioned criteria and decision thresholds |
| `evaluations` | Evaluation history and immutable audit snapshots |

Changing an Agent's rubric never rewrites history; each evaluation stores the rubric snapshot it used.

### Quick start

Requires Node.js 20+.

```powershell
npm install
npm test
npm run build
node dist/src/agent_eval.js upsert-rubric --file examples/rubrics/support-quality-v1.json
node dist/src/agent_eval.js upsert-agent --agent-id support-agent --name "Support Agent"
node dist/src/agent_eval.js assign-rubric --agent-id support-agent --rubric-id support-quality-v1
node dist/src/agent_eval.js evaluate --agent-id support-agent --input examples/cases/support-answer-format-v1.json --dry-run --seed demo-001
```

### Package as a CLI

Create an installable package with an automatic TypeScript build:

```powershell
npm run package
npm install -g .\jev-agent-eval-0.1.0.tgz
```

After installation, use `jev-agent-eval evaluate ...` instead of `node dist/src/agent_eval.js evaluate ...`.

For a live call, put a Cloudflare API token in untracked root `auth.txt`, then provide `--account-id`. Use `--database <path>` for another SQLite registry. The default database, artifacts, and API key are ignored by Git.

### Safeguards

Required deterministic checks are hard gates: failing candidates are reverted without a model call. Jev never sees a baseline/candidate label. Treat ties, inconclusive outcomes, and human-review outcomes as first-class results. Keep optimization and holdout benchmark sets separate, and validate Jev calibration against human labels or objective outcomes before trusting thresholds in production.

## Development

```powershell
npm test
```

## License

No license has been selected yet. Add one before publishing for reuse.
