# PatchCouncil Workbench v1 设计

## 目标

PatchCouncil Workbench v1 的目标是把产品主入口从 CLI 驱动的 council 运行，迁移到浏览器里的本地交互式工作台。

用户只需要启动本地服务、打开 Web UI，然后在 UI 里创建、观察、参与和取消 council session。Node 实现成为唯一活跃产品路径。Python 实现视为历史原型，不再承接新产品能力。

## 非目标

Workbench v1 暂不包含：

- 代码修改或执行编排。
- workplan 审批与执行。
- 暂停 / 恢复控制。
- 从 UI 强制指定下一个 agent。
- WebSocket。
- 独立 worker、daemon 或任务队列。
- 桌面应用打包。

## 产品模型

UI 应该像一个聊天工作台，而不是事件日志查看器。

默认主线程展示高价值讨论内容：

- 初始用户 topic。
- 用户追加指令（host message）。
- agent 完整发言。
- 最终总结卡片。

系统事件仍然完整记录在 `transcript.jsonl` 中，但默认 UI 应弱化展示：

- coordinator 决策显示为紧凑状态行。
- policy override 显示为紧凑状态行。
- 错误需要可见，但不要和底层 runtime 噪声混在一起。
- 详细原始事件通过 debug/raw-events 视图查看。

`coordinator_turn_started`、`coordinator_turn_completed`、runtime delta、duration/status 这类底层生命周期细节不应占据主线程主要空间。

## 用户角色

用户在 council 中的角色是**主持人（Host）**：

- 可以随时通过底部输入框追加指令（interjection）。
- coordinator 不管理用户的发言顺序，用户可以自由插话。
- Host 消息不会中断当前正在发言的 agent，而是排队等待 agent 发言完成后，在下一次 coordinator 决策前注入。

## 主流程

```text
用户打开 Web UI
-> 中间区域居中输入 topic（空闲态）
-> 启动 council session（使用全局默认配置）
-> 输入框下移到底部，变为 host 插话框
-> server 创建 session，并在同一个 Node 进程中启动 council
-> UI 自动选中新 session，并轮询增量 events
-> 用户可以在运行中追加指令（排队注入，不打断当前 agent）
-> 用户可以取消 session
-> session 以 done、error 或 cancelled 收束
-> 结束态：总结卡片置顶 + 对话流可折叠 + 底部输入框显示"Continue"
-> Continue 创建 fork session（带 source 引用），而不是在原 session 上追加
```

## UI 布局

三栏布局，左侧 session 列表始终可见：

```text
左侧栏
  Sessions 列表
  [+ New] 按钮（快速回到空闲态发起新 council）

中间主线程
  空闲态：居中 topic 输入框（类似 ChatGPT 首页）
  运行中：聊天式 council thread + 底部 host 输入框
  已结束：总结卡片置顶 + 可折叠对话流 + 底部 Continue 输入框

右侧检查器
  Session status / phase / turn
  Agents 列表
  Coordinator 最新决策
  Raw events 入口（调试用）
```

### 中间区域状态切换

中间区域是同一个区域在不同状态下的三种形态：

```text
空闲态（无活跃 council）
  ┌─────────────────────────┐
  │                         │
  │    输入讨论主题...       │
  │    [Start Council]      │
  │                         │
  │  agent: codex + claude  │
  │  max 3 turns            │
  └─────────────────────────┘

运行态（council 讨论中）
  ┌─────────────────────────┐
  │  coordinator → codex    │
  │  ┌───────────────────┐  │
  │  │ codex: 建议...     │  │
  │  └───────────────────┘  │
  │  coordinator → claude   │
  │  ┌───────────────────┐  │
  │  │ claude: 风险是...  │  │
  │  └───────────────────┘  │
  │       ┌ host ────────┐  │
  │       │ 先聚焦核心    │  │  ← 右对齐，绿色边框
  │       └──────────────┘  │
  ├─────────────────────────┤
  │ 输入插话...  [Add note] │
  └─────────────────────────┘

结束态（council finalized）
  ┌─────────────────────────┐
  │  ┌─ 讨论总结 ─────────┐ │
  │  │ JWT + refresh ...   │ │  ← 总结卡片置顶
  │  │ 3 turns · 2 agents  │ │
  │  └─────────────────────┘ │
  │  ▶ 展开完整讨论过程      │  ← 对话流可折叠
  ├─────────────────────────┤
  │ 继续讨论...  [Continue] │  ← 创建 fork session
  └─────────────────────────┘
```

## 消息视觉区分

```text
agent 消息气泡（各 agent 不同颜色）
  codex:  浅蓝背景，左侧对齐
  claude: 浅橙背景，左侧对齐

coordinator 决策（系统状态行）
  居中灰色小字，无气泡

host 消息
  右侧对齐，浅绿背景，绿色边框，与 agent 明确区分
```

## 输入框行为

底部输入框根据当前选中的 session 状态改变行为：

```text
没有选中 session（空闲态）
  位置：中间区域居中
  输入含义：启动新的 council session
  按钮文案：Start Council

running session
  位置：中间区域底部
  输入含义：追加用户指令（host interjection）
  按钮文案：Add note
  Interjection 排队等待当前 agent 发言完成，不打断

done、error 或 cancelled session
  位置：中间区域底部
  输入含义：基于当前 session 创建 fork session
  按钮文案：Continue
```

## Session Fork

已完成 session 保持不可变。Continue 会创建一个引用源 session 的新 session，而不是在原 session 上追加。

`session_started` 可包含类似字段：

```json
{
  "source_session_id": "20260528-abc123",
  "source_summary": "上一轮 council 已确认 Workbench v1 采用聊天式 UI。",
  "source_transcript_path": ".project-ai/sessions/20260528-abc123/transcript.jsonl"
}
```

新 session 的 brief 应包含 source summary 和 transcript path。不要直接把源 session 的完整 transcript 全量塞进 prompt。

source summary 的来源规则：

```text
done session
  使用 finalized.summary。

error / cancelled session
  使用 state.topic、已完成的 agent_turn_completed 摘要和 source_transcript_path 组成简短恢复说明。
```

这样即使源 session 没有正常 finalized，也可以基于已有事件创建后续 session。

## Interjection 语义

Interjection 不是强制立即执行的命令，而是用户提供给下一个安全决策点的上下文。

关键行为：
- Host 消息不打断当前正在运行的 CLI 调用（agent 发言）。
- Engine 在模型调用之间检查 interjections，把新的 interjections 纳入下一次 coordinator brief。
- 这样可以保持当前只读 council 模型，同时让用户参与运行中的讨论。

## 全局配置页

独立的 `/config` 页面（或路由），设置全局默认值：

```yaml
council:
  max_turns: 3
  min_distinct_agents: 2
  coordinator: codex
  # 上下文压缩
  max_context_chars: 2500
  max_transcript_chars: 2500
  max_message_chars: 800

agents:
  codex:
    enabled: true
    capabilities: [plan, synthesize, review, judge]
    roles: [coordinator, agent]
  claude:
    enabled: true
    capabilities: [challenge, implement, fix]
    roles: [agent]
```

发起 council 时直接使用全局默认配置，不弹出配置面板。用户需要改变配置时主动跳转到 `/config` 页面修改。

配置修改只影响之后新建的 sessions：

```text
session_started 保存启动时的 config snapshot。
PUT /api/config 不热更新 running session。
running session 的 max_turns、agents、context limits 等行为以 session_started 中的配置快照为准。
```

## Server 执行模型

Workbench v1 使用单 Node 进程模型。

```text
Browser UI
-> server.js HTTP API
-> 进程内 council async task
-> transcript.jsonl / state.json
-> UI polling 增量读取 events
```

server 维护一个 `activeSessions` registry，保存当前进程内启动的 running sessions。每个 running session 有一个 controller object，用于接收 interjection 和 cancellation request。

这个设计故意比 worker/queue 架构简单。若 server 进程退出，正在运行的 session 会停止。事件日志仍然是已写入内容的唯一事实来源。

## HTTP API

保留现有读取 API：

```text
GET /api/sessions
GET /api/sessions/:id/events?since=N
```

Workbench v1 新增：

```text
POST /api/sessions
```

创建并启动新的 council session。

Request：

```json
{
  "topic": "讨论 UI 从 viewer 升级成工作台",
  "mode": "council",
  "source_session_id": "optional-existing-session-id"
}
```

Response：

```json
{
  "session_id": "20260528-abc123",
  "status": "running"
}
```

```text
POST /api/sessions/:id/interjections
```

向 running session 追加用户指令。interjection 会立即落盘，并在下一次 coordinator brief 中可见。

Request：

```json
{
  "content": "补充：取消按钮要立即进入 cancelling，并尽量终止当前 CLI。"
}
```

```text
POST /api/sessions/:id/cancel
```

请求取消 running session。

Response：

```json
{
  "session_id": "20260528-abc123",
  "status": "cancelling"
}
```

```text
GET /api/config
PUT /api/config
```

读取和更新全局配置。

## 新增 Council Events

Workbench v1 新增两个 council-level events。

### user_interjection

记录用户在 session 运行中追加的指令。

```json
{
  "schema_version": 1,
  "seq": 12,
  "type": "user_interjection",
  "phase": "discussion",
  "session_id": "20260528-abc123",
  "turn": 2,
  "content": "请把取消语义也纳入讨论。",
  "created_at": "2026-05-28T10:20:00+08:00"
}
```

engine 会在后续 council brief 中纳入新的 interjections。interjection 不会中断当前正在运行的 CLI 调用。

### session_cancel_requested

记录用户发起的取消请求。

```json
{
  "schema_version": 1,
  "seq": 13,
  "type": "session_cancel_requested",
  "phase": "discussion",
  "session_id": "20260528-abc123",
  "requested_at": "2026-05-28T10:21:00+08:00",
  "reason": "user"
}
```

该事件出现后，engine 不应再启动新的 coordinator 或 agent turn。

## 取消语义

取消对用户来说应立即生效；对 runtime 来说是 best-effort。

```text
用户点击 Cancel
-> server 写入 session_cancel_requested
-> state.status 变为 cancelling
-> runtime adapter 尝试终止当前 CLI 进程
-> engine 不再启动新的 turn
-> session 以 outcome=cancelled 收束
```

如果当前 CLI 调用无法立即终止，engine 等待它返回或超时，然后仍以 cancelled 收束。取消后返回的内容不应触发新的 coordinator decision 或 agent turn。

`session_finished.outcome` 必须支持：

```text
cancelled
```

`state.status` 应支持：

```text
cancelling
```

UI 在 cancel request 被接受后，应立即显示 cancelling 状态。

## UI 事件投影

UI 应从 events 派生聊天消息，不要引入独立的 chat storage model。

推荐投影：

```text
session_started
  -> 用户 topic 消息

user_interjection
  -> 用户消息（host，右对齐，绿色边框）

agent_turn_completed
  -> agent 消息（按 agent 颜色区分气泡）

finalized
  -> 总结卡片置顶（包含 summary + next_steps）

coordinator_decided
  -> 紧凑系统状态行（居中灰色小字）

policy_override
  -> 紧凑系统状态行

agent_error / coordinator_error / session_error
  -> 可见错误消息
```

Raw event 模式可以继续渲染现有逐事件 timeline，用于调试。

## Python CLI 退场

Python 实现应停止作为产品路径。

推荐退场路径：

1. 更新文档，明确 Node Workbench 是活跃路径。
2. 停止向 `src/aictl` 添加新功能。
3. 在 Workbench v1 稳定前，暂时保留 Python 文件作为参考实现。
4. 后续 cleanup PR 中移除或归档 Python 原型。

Node CLI 可以保留为开发和调试入口，但用户应通过 Web UI 创建和控制 council sessions。

## 测试策略

测试重点放在行为，而不是视觉细节。

Server/API tests：

- 创建 session 返回 running session id。
- 对 running session 添加 interjection 会追加 `user_interjection`。
- 对非 running session 添加 interjection 会被拒绝。
- 对 running session cancel 会追加 `session_cancel_requested`。
- 对非 running session cancel 应幂等处理，或返回清晰错误。
- 基于 completed session continue 会创建带 source metadata 的新 session。
- GET/PUT /api/config 读写全局配置。

Engine tests：

- interjections 会进入下一次 coordinator brief。
- interjection 不中断当前正在运行的 agent turn。
- cancellation 会阻止当前安全点之后的新 turns。
- cancellation 会产生 `session_finished`，且 `outcome=cancelled`。
- runtime 终止失败时，仍会在超时或返回后以 cancelled 收束。

UI tests/smoke：

- New Council 流程会创建 session 并自动选中。
- 空闲态中间区域显示居中 topic 输入框。
- running session 的输入框会发送 interjection。
- completed session 的输入框会创建 fork session（Continue）。
- 结束态显示总结卡片 + 可折叠对话流。
- 主线程默认隐藏低层生命周期噪声。
- Raw events 视图仍能展示完整 events。

## 开放决策

Workbench v1 没有阻塞性开放决策。

以下决策有意延后：

- 是否用 WebSocket 替代 polling。
- 是否把 council execution 拆成 worker process。
- workplan approval 是否放入 Workbench v2。
- 本地 Web UI 稳定后，是否需要桌面应用包装。
