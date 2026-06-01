# PatchCouncil Workplan v1 设计

## 目标

Workplan v1 的目标是在 council 讨论完成后，按需生成一份结构化实施计划。它把 Workbench v1 的讨论结果转化为可阅读、可审计、未来可执行器消费的计划产物。

用户在 `status=done` 的 session 上点击 `Generate Workplan` 后，系统基于该 session 的事件日志调用 AI 生成严格 JSON，并把结果追加为同一个 `transcript.jsonl` 中的 council-level event。

## 非目标

Workplan v1 不包含：

- 自动执行任务。
- 修改项目文件。
- 进入 `task_assignment` 或 `execution` phase。
- 用户手工编辑 workplan。
- 同一个 session 内多个成功 workplan 版本。
- 对 `cancelled` 或 `error` session 生成 workplan。
- 独立 worker、daemon、queue 或 WebSocket。

## 产品规则

第一版采用只读、单成功产物模型：

```text
Session A discussion
-> finalized
-> session_finished(status=done, outcome=discussion_only)
-> 用户点击 Generate Workplan
-> workplan_generation_started
-> workplan_created
```

每个 session 最多允许一个成功的 `workplan_created`。如果用户需要修订计划，应使用现有 Continue/Fork 机制开新 session 讨论，再在新 session 中生成新的 workplan。

生成失败可以重试：

```text
允许多个 workplan_generation_failed
最多一个 workplan_created
一旦 workplan_created 存在，不允许再次生成
```

## Workplan Schema

`workplan_created.workplan` 使用小而稳定的结构：

```json
{
  "title": "string",
  "rationale": "string",
  "goal": "string",
  "scope": ["string"],
  "non_goals": ["string"],
  "tasks": [
    {
      "id": "T1",
      "title": "string",
      "description": "string",
      "files": ["string"],
      "depends_on": [],
      "verification": ["string"]
    }
  ],
  "risks": [
    {
      "risk": "string",
      "mitigation": "string"
    }
  ]
}
```

字段含义：

- `title`：计划标题。
- `rationale`：关键取舍和为什么这样做。
- `goal`：这份计划要达成的结果。
- `scope`：明确包含的工作。
- `non_goals`：明确不做的工作。
- `tasks`：可执行任务分解。
- `tasks[].files`：预计涉及的文件或目录，可以为空。
- `tasks[].depends_on`：依赖的 task id，可以为空。
- `tasks[].verification`：完成后如何验证。
- `risks`：主要风险和缓解方式。

## 架构

Workplan 生成是 finalized discussion 的派生产物，不开启新的 phase。

```text
POST /api/sessions/:id/workplan
-> server 校验 session status == done
-> 校验 transcript 中没有 workplan_created
-> 追加 workplan_generation_started
-> 从 transcript.jsonl 构建 Workplan Brief
-> 调用 planner/coordinator AI
-> 解析并校验严格 JSON
-> 追加 workplan_created 或 workplan_generation_failed
-> 更新 state.json / transcript.md
-> UI 通过轮询看到新事件并渲染 Workplan 卡片
```

第一版复用现有 Node server 进程、runtime adapter、prompt renderer 和 fake runtime smoke 路径。不新增独立后台 worker。

## Workplan Brief

Workplan Brief 从 `transcript.jsonl` 派生，遵守现有 context limit 思路，不把完整 transcript 全量塞给模型。

Brief 应包含：

- 原始 topic。
- `finalized.summary` 和 `finalized.next_steps`。
- 所有 `agent_turn_completed` 的压缩摘要，避免多轮讨论中的文件边界、风险和取舍在计划生成时丢失。
- 最近的 `agent_turn_completed` 可保留更宽的片段，用于补充尾部细节。
- 完整 transcript 路径，供审计和人工追溯。
- 如果 source session 已有 workplan，在 Continue/Fork 后生成计划时包含 source workplan 摘要。

Workplan Brief 可以比 council loop 的普通 brief 更宽，因为它只在用户显式请求时运行一次，不参与每轮动态路由。实现时应使用独立的 workplan brief limits，默认仍保持有界输入。

## Event Model

新增 council-level events：

```text
workplan_generation_started
workplan_created
workplan_generation_failed
```

这些事件默认写入 `transcript.jsonl`。

### workplan_generation_started

用户触发生成时立即落盘，用于审计和 UI 生成中状态。

```json
{
  "schema_version": 1,
  "seq": 15,
  "type": "workplan_generation_started",
  "phase": "finalized",
  "session_id": "20260601-abc123",
  "requested_at": "2026-06-01T22:00:00+08:00",
  "generator": "codex"
}
```

### workplan_created

成功生成的结构化计划。

```json
{
  "schema_version": 1,
  "seq": 16,
  "type": "workplan_created",
  "phase": "finalized",
  "session_id": "20260601-abc123",
  "created_at": "2026-06-01T22:00:10+08:00",
  "generator": "codex",
  "source": {
    "summary_event_seq": 13,
    "transcript_path": ".project-ai/sessions/20260601-abc123/transcript.jsonl"
  },
  "workplan": {
    "title": "Add structured workplan generation",
    "rationale": "Council agreed planning should precede execution.",
    "goal": "Generate a structured implementation plan from a finalized discussion.",
    "scope": [],
    "non_goals": [],
    "tasks": [],
    "risks": []
  }
}
```

### workplan_generation_failed

AI 调用失败、JSON 解析失败或 schema 校验失败时落盘。失败后允许用户重试。

```json
{
  "schema_version": 1,
  "seq": 16,
  "type": "workplan_generation_failed",
  "phase": "finalized",
  "session_id": "20260601-abc123",
  "failed_at": "2026-06-01T22:00:10+08:00",
  "generator": "codex",
  "message": "failed to parse workplan JSON",
  "recoverable": true,
  "action": "show_error"
}
```

## State 派生

`state.json` 继续从事件流派生。

Workplan v1 增加派生字段：

```json
{
  "has_workplan": true,
  "workplan_status": "created"
}
```

`workplan_status` 取值：

```text
none
generating
created
failed
```

派生规则：

- 没有 workplan 事件：`none`。
- 最新 workplan 事件是 `workplan_generation_started`：`generating`。
- 存在 `workplan_created`：`created`，`has_workplan=true`。
- 最新 workplan 事件是 `workplan_generation_failed` 且没有成功事件：`failed`。
- `state.status` 保持 `done`，不因 workplan 生成而变成 running。
- `state.outcome` 保持 `session_finished.outcome`，例如 `discussion_only`。

Workplan 是 post-discussion artifact，不修正已经结束的 discussion outcome。调用方应通过 `has_workplan` 和 `workplan_status` 判断计划产物状态，而不是把 `state.outcome` 当作 artifact 状态。

## API

新增接口：

```text
POST /api/sessions/:id/workplan
```

成功响应：

```json
{
  "session_id": "20260601-abc123",
  "status": "generating"
}
```

校验规则：

- 找不到 session：`404`。
- session 不是 `done`：`409`。
- 已有 `workplan_created`：`409`。
- 当前已有未闭合的 `workplan_generation_started`：`409`。
- 其他请求体错误：`400`。

服务端先返回 `202`，再异步生成 workplan。UI 继续通过现有事件轮询更新状态。

## UI

Workbench 在 completed session 的总结区域附近展示 Workplan 入口和结果。

状态：

```text
done + no workplan -> 显示 Generate Workplan
generating -> 显示生成中
failed -> 显示错误和重试入口
created -> 显示 Workplan 卡片，隐藏或禁用生成按钮
```

Workplan 卡片展示：

- title。
- rationale。
- goal。
- scope / non_goals。
- tasks，包括依赖、文件边界和验证方式。
- risks。

如果用户需要修改 plan，UI 提示通过 Continue/Fork 继续讨论，而不是在当前 session 内编辑或重生成成功版本。

## Prompt

新增 prompt 模板建议命名：

```text
engine/prompts/workplan_create.md
```

要求：

- 只输出 JSON，不输出 Markdown 包裹。
- 不提出执行命令或修改文件。
- 不省略必需字段。
- 如果讨论不足以生成计划，也要生成保守计划，并在 `risks` 中说明不确定性。

Prompt 设计契约：

- 角色：生成器不是继续参与讨论的 agent，而是把已完成 council discussion 翻译成实施计划的 planner。
- 任务粒度：每个 task 应该是一项可验证的工程改动。不要把整项功能塞进一个 task，也不要把机械子步骤拆得过碎。
- 文件边界：必须尽量列出预计涉及的文件或目录。如果无法确定，`files` 可以为空，但 `description` 或 `risks` 必须说明不确定性。
- 验证方式：每个 task 至少给出一个 `verification`。优先使用项目已有命令，例如 `npm run check`、`npm run smoke`、`npm run runtime:fake`。不能编造不存在的命令；不确定时写人工验证或在 `risks` 中记录待确认项。
- 范围控制：只生成 plan，不执行，不要求修改文件。必须保留 `non_goals`，防止 plan 越界。
- 保守性：如果讨论信息不足，生成保守计划，并把缺失信息、依赖假设和风险写入 `risks`。
- 输出格式：只输出严格 JSON；不得使用 Markdown fence；不得添加 schema 外字段。

## Generator 选择

Workplan v1 默认复用当前配置中的 coordinator 选择逻辑，而不是硬编码某个 agent。事件里的 `generator` 字段记录实际被选中的 agent id，例如 `codex`。

第一版不新增 per-request generator 参数。后续如果需要在 UI 中选择 planner agent，可以在配置页增加默认 workplan generator，再由 API 读取配置快照。

## Phase 归属

Workplan 事件使用 `phase: "finalized"`，表示事件发生时 discussion phase 已经收束。它不表示重新进入 `finalized` 动作，也不改变 `finalized` 事件本身的语义。

回放和 UI 应通过事件类型区分：

```text
finalized = discussion 总结
workplan_created = finalized discussion 之后生成的计划产物
```

## 测试策略

Session store / event 层：

- 新事件常量和构造函数存在。
- `workplan_generation_started` 派生 `workplan_status=generating`。
- `workplan_created` 派生 `has_workplan=true`、`workplan_status=created`，但不改变 `state.outcome`。
- `workplan_generation_failed` 派生 `workplan_status=failed`。
- `transcript.md` 能渲染 workplan 摘要和失败信息。
- source metadata / Continue 能包含 source workplan 摘要。

Server API 层：

- `POST /api/sessions/:id/workplan` 对 `done` session 返回 `202`。
- 非 done session 返回 `409`。
- cancelled / error session 返回 `409`。
- 已有 `workplan_created` 返回 `409`。
- 正在生成返回 `409`。
- AI 输出合法 JSON 时追加 `workplan_created`。
- AI 调用失败、JSON 解析失败或 schema 不合法时追加 `workplan_generation_failed`，并允许重试。
- fake runtime 覆盖合法 JSON、非法 JSON、不完整 JSON 和 schema 不合法 JSON，验证 parse 与 schema 校验路径。

UI smoke：

- done session + no workplan 显示 `Generate Workplan`。
- generating 显示生成中。
- created 显示 Workplan 卡片。
- failed 显示错误和重试入口。
- 已有 workplan 后不再显示生成按钮，并提示通过 Continue 修订。

## 边界与后续

Workplan v1 是执行编排前的最小可验证台阶。它验证 council 是否能稳定产出高质量实施计划，同时保持只读安全边界。

后续阶段可以在此基础上增加：

- `task_assignment` phase。
- 用户审批 workplan。
- `runtime.approval.requested` 驱动的命令和写文件审批。
- 多 agent 分工执行和 review。

这些后续能力不属于 Workplan v1。
