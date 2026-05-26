# 决策记录

这个文件记录已经相对稳定的项目决策和背后的理由。

## 2026-05-26：从固定工作流转向 Council 协调

状态：已接受

### 背景

最初 MVP 使用显式工作流命令和固定顺序：

```text
Codex 起草计划
-> OpenCode 挑战计划
-> Codex 形成最终计划
-> OpenCode 执行实现
-> Codex 审查 git diff
-> 必要时 OpenCode 修复
-> 写入长期记忆
```

这套流程可控，但对于探索多 AI 协作来说过于线性。

### 决策

保留显式工作流命令，但让 `council` 成为动态多 agent 讨论的主要实验路径。

### 影响

- AI 角色可以根据上下文选择，而不是被固定到流水线位置。
- 系统需要 coordinator 逻辑和策略兜底。
- 显式命令仍然保留，用于调试和确定性工作流。

## 2026-05-26：使用 Coordinator 控制 Agent 路由

状态：已接受

### 背景

第一版 council 原型仍然使用固定顺序：

```text
Codex 发言
-> OpenCode 挑战
-> Codex 总结
```

这比普通任务流水线更适合讨论，但仍然硬编码了谁在什么时候发言。

### 决策

使用 coordinator loop：

```text
用户主题
-> coordinator 选择下一位 agent
-> 被选中的 agent 发言
-> coordinator 判断继续或收束
-> coordinator 输出最终总结
```

### 影响

- council 可以根据讨论状态动态调整。
- coordinator prompt 会成为行为质量的关键。
- 系统需要明确的最大轮数限制，避免无限讨论。

## 2026-05-26：每个 Council Session 保存为 Transcript 和 State

状态：已接受

### 背景

如果每一轮 AI 回复都创建一个 Markdown 文件，讨论会被切得太碎，不利于阅读和回溯。

### 决策

每个 session 保存为：

```text
.project-ai/sessions/<session-id>/
  transcript.md
  transcript.jsonl
  state.json
```

### 影响

- 人类可以阅读 `transcript.md`。
- 后续工具可以处理 `transcript.jsonl`。
- 运行时 session 产物通常不应进入 git。

## 2026-05-27：Council Session 使用事件日志作为唯一事实来源

状态：已接受

### 背景

Council 的价值不只是最终总结，而是用户能观察多个 AI 的讨论过程。原有 `transcript.md`、`transcript.jsonl`、`state.json` 并列维护，长期容易出现状态不一致。

未来还需要支持 session replay、TUI/Web UI，以及讨论后分工执行。这要求 session 生命周期有一条稳定、可重放、可审计的事件流。

### 决策

将 session 存储职责明确为：

```text
transcript.jsonl = 唯一权威事件日志
state.json = 从事件流派生的当前状态快照
transcript.md = 从事件流渲染的人类可读视图
```

事件 schema 定义在 `docs/COUNCIL_EVENTS.md`。

每个事件应包含 `schema_version`、`seq`、`type`、`phase` 和 `session_id`。`session_started` 保存配置和 agent 快照；`phase_transition` 显式记录阶段切换；`session_finished` 保存最终 outcome summary。

### 影响

- `state.json` 可以用于快速查询，但必须能从事件日志重建。
- `transcript.md` 不再作为独立写入目标，而应由事件日志生成。
- CLI 实时渲染和 session replay 可以复用同一套事件 renderer。
- 错误需要成为一等事件，例如 `agent_error`、`coordinator_error` 和 `session_error`。
- 未来执行编排可以继续追加事件到同一个 session 日志，而不是另建日志系统。

## 2026-05-27：先做 Node/TypeScript 可视化 UI Spike

状态：已接受

### 背景

用户真正想看的不是 council 的最终结果，而是 AI 讨论的过程。继续在 Python CLI 上做复杂展示，会把精力投入到非最终产品形态上。

参考 `wenwen-0617/roundtable` 后可以确认：本地 Web 圆桌方向可行，Node/JavaScript 生态适合做 session list、timeline、状态面板和后续实时 UI。

### 决策

下一步先做 Node/TypeScript UI spike，用 mock events 验证产品体验：

```text
session list
discussion timeline
work/status panel
phase / agent / coordinator / policy / error 展示
```

暂时不接真实 Codex/OpenCode，不实现 WebSocket，不做复杂持久化。

UI spike 后设置 checkpoint，再决定：

```text
路径 A：Node 全栈，Node child_process 调 AI CLI，council loop 在 Node 重写。
路径 B：Python engine + Node UI，Python 继续跑 council，jsonl 作为语言边界。
```

### 影响

- CLI 继续作为启动、调试和自动化入口，不作为主要观察界面。
- 事件 schema 和 UI 消费体验会先被验证，再决定 runtime integration。
- 现有 Python council loop 暂不立刻重写，也不继续深挖复杂 CLI renderer。

## 2026-05-27：区分 Runtime Events 和 Council Events

状态：已接受

### 背景

Codex、OpenCode、Claude 等 CLI 的原始输出格式不同。旧设计中的 `agent_chunk` 混入 council event，会把底层 streaming 细节和产品语义绑在一起。

### 决策

事件模型分为两层：

```text
runtime events = adapter 层事件，例如 runtime.reply.delta、runtime.turn.failed、runtime.approval.requested
council events = 产品层事件，例如 coordinator_decided、agent_turn_completed、policy_override
```

adapter 先把各 AI CLI 的原始输出归一化为 runtime events，orchestrator 再提升为 council events。

### 影响

- `runtime.reply.delta` 取代 `agent_chunk`，用于实时 UI，不默认落盘。
- `agent_turn_completed.content` 仍是 council log 中完整发言的事实来源。
- approval 作为 runtime 层一等事件预留，为未来执行编排做准备。

## 2026-05-26：Coordinator 决策暂时使用 Markdown

状态：已接受

### 背景

严格 JSON 路由更容易稳定解析，但在核心 loop 尚未稳定时会引入额外格式约束和兜底复杂度。

### 决策

暂时使用 Markdown 章节表示 coordinator 决策：

```text
## Decision
## Next agent
## Role
## Reason
```

### 影响

- 实现更轻，内容也更容易人工检查。
- 解析稳定性不如严格 JSON。
- 后续迁移到 JSON 时，需要补齐兜底策略。

## 2026-05-26：增加最少不同 Agent 参与策略

状态：已接受

### 背景

真实 council 测试表明，当用户要求简短讨论时，coordinator 可能合理地在只有 Codex 发言后就收束。但如果这种情况经常发生，council 会退化成单 agent 回答。

### 决策

增加：

```yaml
council:
  min_distinct_agents: 2
```

如果 coordinator 过早收束，并且 session 还没达到 `max_turns`，策略层可以强制选择一个尚未发言的 agent。

### 影响

- council 行为更能体现多 agent 协作。
- 策略覆盖需要在 transcript 中显式记录。
- 系统有时会在 coordinator 本想停止时继续一轮。

## 2026-05-26：增加 Council 上下文压缩

状态：已接受

### 背景

把完整项目上下文和完整 transcript 都通过 `opencode run "message"` 传入时，Windows 上最终会触发：

```text
The command line is too long.
```

改成文件输入只能绕过命令行长度限制，不能解决 prompt 膨胀问题。

### 决策

增加规则型上下文压缩：

```yaml
council:
  max_context_chars: 2500
  max_transcript_chars: 2500
  max_message_chars: 800
```

每轮模型调用只接收有边界的 Council Brief，而不是完整 transcript。

### 影响

- 完整 transcript 仍保存在磁盘。
- 模型调用更小、更可靠。
- 上下文压缩行为需要补单元测试。
