# 架构

这个文件记录 `aictl` 当前稳定的系统设计。新开 AI 对话时，应先读 `docs/AI_CONTEXT.md`。

## 系统目标

`aictl` 用于协调本地 AI 命令行工具。当前架构重点是一个轻量的 council loop，让多个 AI agent 可以围绕用户主题进行讨论，并由 coordinator 控制流程。

## 命令层次

项目目前有两个概念层：

- 显式工作流命令：`plan`、`do`、`review`、`auto`、`continue`。
- Council 讨论命令：`council`。

显式命令仍然适合确定性工作流、调试和精确控制。`council` 是当前探索动态多 AI 协作的主要路径。

## 体验方向

Council 的核心体验应该是“看见 AI 如何讨论”，而不是只得到最终总结。

因此当前方向是先做本地可视化 UI spike，而不是继续加重 CLI 渲染：

```text
Node/TypeScript UI spike
-> mock council events
-> session list
-> discussion timeline
-> work/status panel
-> checkpoint 决定 engine 方向
```

CLI 仍然有价值，但定位应是启动、调试和自动化入口，不是主要观察界面。

## Council Loop

Council loop 由 coordinator 驱动：

```text
用户主题
-> coordinator route prompt
-> 被选中的 AI agent 发言
-> coordinator decision prompt
-> 重复，直到收束或达到最大轮数
-> coordinator finalization prompt
```

coordinator 负责：

- 选择下一位 agent；
- 为本轮发言指定角色；
- 判断继续讨论是否仍然有价值；
- 输出最终总结。

agent 不再永久绑定到固定角色。coordinator 应根据当前讨论状态选择合适的 agent。

## 只读行为

Council 模式当前是只读的。它可以讨论、评估和总结，但不应该直接编辑文件。

这样可以让 council loop 适合设计评审和规划，同时避免开放式讨论意外改动文件。

## 会话模型

每个 council session 写入：

```text
.project-ai/sessions/<session-id>/
  transcript.md
  transcript.jsonl
  state.json
```

`transcript.jsonl` 是唯一权威事件日志。

`state.json` 是从事件流派生的当前状态快照，用于快速查询和 session list。

`transcript.md` 是从事件流渲染的人类可读视图。

事件 schema 见 `docs/COUNCIL_EVENTS.md`。任何重要业务事实都应能从 `transcript.jsonl` 重建，避免多个文件各自维护状态。

session 文件是运行时产物，通常不应进入 git。

## 可观察事件流

Council 不应只是输出最终总结。它应该把 coordinator 决策、agent 发言、策略覆盖、阶段切换和错误处理都表达成结构化事件。

事件模型分为两层：

```text
runtime events：adapter 层，描述 AI CLI 的运行事实。
council events：产品层，描述 council 的语义事实。
```

内部形态应接近：

```text
AI CLI raw output
-> runtime adapter
-> runtime events
-> council orchestrator
-> council events
   -> JsonlSink 写 transcript.jsonl
   -> StateSnapshotSink 更新 state.json
   -> UI / minimal CLI printer 消费事件
   -> session 结束后从 jsonl 生成 transcript.md
```

`runtime.reply.delta` 可用于实时流式渲染，但默认不写入 `transcript.jsonl`。`agent_turn_completed` 是 council 层完整发言事件，应写入完整回复内容，保证事件日志可以完整重建 session。

## 上下文压缩

不能把完整项目上下文和完整 transcript 历史传给每一次模型调用。

每轮模型调用应收到一个有边界的 Council Brief，包含：

- 原始 topic；
- 裁剪后的项目上下文；
- 最近的相关讨论消息；
- 完整 transcript 路径。

完整 transcript 仍然保存在磁盘上，便于审计和调试；模型输入保持较小，便于可靠地调用 CLI。

## CLI Adapter 行为

通用 CLI adapter 会流式读取子进程输出，并在模型命令仍在运行时定期打印进度。

示例状态输出：

```text
codex still running as council-route (30s elapsed). last stderr: ...
```

这样用户可以看到长时间生成、重试或重连状态。

这类 heartbeat 更适合作为 CLI runtime 状态，不应默认写入核心事件日志。真正影响 session 语义的失败应记录为 `agent_error`、`coordinator_error` 或 `session_error`。

## OpenCode 集成

OpenCode 当前配置围绕：

```yaml
opencode:
  command: opencode
  args:
    - run
  input_mode: argument
```

通过 Python subprocess 的 argv 方式调用时，`opencode run "message"` 可用。Windows 上需要注意 shell 引号和超长单条命令行消息。

后续如果 checkpoint 选择 Node 全栈，需要用 Node `child_process` 重新验证 Codex/OpenCode 调用、流式输出、取消和错误处理。若选择 Python engine + Node UI，则以 `transcript.jsonl` 作为语言边界。

## Prompt 组织

旧的固定顺序 council prompt 已删除：

```text
council_first.md
council_challenge.md
council_synthesis.md
```

当前有效的 council prompt：

```text
council_route.md
council_agent_turn.md
council_decide.md
council_finalize.md
```

## 策略层

Council loop 在 coordinator 判断之外，还有一个小的策略层。

当前重要策略：

```yaml
council:
  min_distinct_agents: 2
```

如果 coordinator 试图过早收束，而 session 还没有达到 `max_turns`，策略层可以强制选择另一个尚未发言的 agent 参与。
