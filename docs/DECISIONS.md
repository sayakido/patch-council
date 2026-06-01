# 决策记录

这个文件记录已经相对稳定的项目决策和背后的理由。

## 2026-05-28：Workbench 成为主入口，Python 原型退场

状态：已接受

### 背景

Node 全栈 council engine、session store、CLI 入口和 Web UI 实时轮询已经跑通。当前 UI 已不再只是 mock viewer，而具备从真实 `.project-ai/sessions` 读取 session、按事件流展示讨论过程的基础。

继续把用户主入口放在 CLI 上，会让交互体验受限于命令行：用户只能启动和等待，很难在运行中插话、取消、查看结构化状态或继续历史 session。与此同时，Python `src/aictl` 已经主要作为历史原型存在，后续继续维护两套产品路径会增加认知和实现成本。

### 决策

将 PatchCouncil 的主体验升级为浏览器里的本地 Workbench：

```text
npm run start
-> 打开 Web UI
-> 创建 council session
-> 实时观察讨论
-> Host 追加指令
-> 取消 running session
-> Continue 已完成 session，创建 fork session
```

Node 全栈实现（`apps/patchcouncil-ui`）成为唯一活跃产品路径。Node CLI 可以保留为开发、调试和自动化入口，但不再作为用户发起 council 的主要界面。

Python `src/aictl` 进入参考/退场状态：不再承接 Workbench v1 新能力，待 Node Workbench 稳定后再移除或归档。

### 影响

- Web UI 从历史事件查看器升级为交互式工作台。
- server 需要提供创建 session、Host interjection、cancel、config 和 Continue/Fork 相关 API。
- council event model 继续作为唯一事实来源，UI 从事件流投影出聊天式主线程和 raw events debug 视图。
- `session_started` 需要保存启动时配置快照，后续 `/config` 修改只影响新 session。
- Python 原型相关文档需要标注为参考实现，避免新功能继续落到 `src/aictl`。

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

## 2026-05-27：Node Runtime Adapter Spike 通过 Fake 矩阵和 Codex 轻量验证

状态：已接受

### 背景

Node 全栈路线的最大风险不是 council loop 本身，而是 Node 是否能可靠替代 Python 的 subprocess/streaming adapter。

需要重点验证：

```text
Windows 命令解析
.cmd/.exe/.bat/.ps1 后缀发现
argv 调用，避免 shell 引号问题
stdout/stderr 流式读取
超时和进程清理
进程崩溃映射为 runtime.turn.failed
真实 Codex/OpenCode CLI 兼容性
```

### 决策

新增 Node runtime adapter spike：

```text
apps/patchcouncil-ui/src/runtime/cli-adapter.js
apps/patchcouncil-ui/src/runtime/resolve-command.js
```

fake runtime 覆盖：

```text
正常流式输出
纯文本输出
进程崩溃
超时
```

真实 CLI 验证结果：

```text
npm run runtime:codex    已通过，验证 codex.cmd 发现和 codex --help 流式读取
npm run runtime:claude   待验证（opencode 已卸载，替换为 claude）
```

### 影响

- Node adapter 已经证明可以覆盖核心进程行为和 Codex 轻量调用。
- 后续决定将 opencode 替换为 claude，继续推进 Node 全栈。详见 opencode→claude 决策条目。

## 2026-05-27：opencode → claude 替换

状态：已接受

### 背景

`opencode` 已被卸载。Node runtime adapter spike 验证了 `codex --help`，但 `opencode` 因 PATH 不可用而跳过。

Claude Code CLI（`claude`）作为替代方案有几个优势：
- 原生 `--output-format stream-json` + `--include-partial-messages`，与 Codex `--json` 一样可直接对接 adapter
- `--no-session-persistence` 避免残留 session 文件
- `--permission-mode bypassPermissions` 跳过交互式授权
- `--max-budget-usd` 控制成本

### 决策

将 agent 配置从 `codex + opencode` 改为 `codex + claude`：
- codex：coordinator + agent（capabilities: plan, synthesize, review, judge）
- claude：agent（capabilities: challenge, implement, fix）

### 影响

- 需要验证 `claude` 通过 runtime adapter（`npm run runtime:claude`）
- Claude Code CLI 的 argument 模式（`claude -p "message"`）和 `opencode run "message"` 调用形态相似，迁移成本低
- Claude Code CLI 的 JSON 流式输出比 OpenCode 的纯文本输出更适合结构化事件管线
- 未来如果加入更多 agent，adapter 的 `parseRuntimeLine` 已支持通用 JSONL 解析

## 2026-05-27：决定推进 Node 全栈路线

状态：已接受

### 背景

Node runtime adapter spike 已通过 fake 矩阵 + 真实 codex 验证。全栈 Node 的主要技术风险（Windows subprocess、流式输出、超时清理）已打掉。

### 决策

选择 Node 全栈而非 Python engine + Node UI。详细实现计划见 `docs/ROADMAP.md`。

### 影响

- Python council loop（`src/aictl/workflows/council.py` 等）作为参考实现保留，待全栈稳定后移除
- 事件类型定义（`events.ts`）成为 engine 和 UI 的共享单源真相
- `transcript.jsonl` 作为唯一权威日志的设计保持不变

## 2026-06-02：Agent Turn Signal + Finalize Gate

状态：已接受

### 背景

实际测试中出现过 coordinator 过早收束讨论的情况。`min_distinct_agents` 可以避免 council 退化为单 agent 回答，但它只能保证“至少有几个 agent 发言”，不能判断这些 agent 是否真的认为讨论已经成熟。

当 coordinator 和参与讨论的 agent 都可能由同一种 LLM 承担时，单靠 coordinator 判断 `finalize` 会让同一模型既发言又裁判，收束标准偏主观。

### 决策

每个 `agent_turn_completed` 增加结构化 `signal`：

```json
{
  "stance": "agree | disagree | mixed",
  "confidence": "low | medium | high",
  "finalize_readiness": "ready | not_ready",
  "blockers": [],
  "agreements": [],
  "disagreements": [],
  "recommended_next_step": "string"
}
```

`content` 保存给用户阅读的自然语言 analysis，`signal` 保存策略层使用的结构化判断。

Coordinator 仍然可以提议 `finalize`，但 engine 在接受前执行 finalize gate：

- latest signal per distinct agent 的数量必须满足 `min_distinct_agents`。
- latest signals 不能包含 blockers。
- 不能所有 latest signals 都是 `finalize_readiness=not_ready`。
- `disagree + not_ready` 阻止 finalize。
- `disagree + ready` 不阻止 finalize，但 final summary 必须能看到并记录 disagreements。

为避免无限讨论，增加：

```yaml
council:
  finalize_gate_max_overrides: 2
```

达到覆盖上限且没有未发言 enabled agent 时，engine 允许 fallback finalize，并把未解决问题写入 `policy_override.reason` 和 finalization brief。

### 影响

- `agent_turn_completed.signal` 成为新 session 的常规字段；旧 session 仍需兼容缺失。
- `council_agent_turn.md` 从 Markdown 章节输出改为严格 JSON 输出。
- `policy_override` 新增 `finalize_gate`、`finalize_gate_fallback`、`avoid_coordinator_first_agent` 等策略原因。
- Finalization brief 必须包含 latest agent signals，避免 ready 状态下的 disagreements 被最终总结遗漏。
- 后续仍需要单独讨论 Brief/context budget，尤其是 signal block 自身的裁剪和优先级策略。

## 2026-05-27：Coordinator 决策直接使用 JSON

状态：已接受

### 背景

Python 原型阶段，为了快速验证 council loop，coordinator 使用 Markdown 章节输出决策（`## Decision`、`## Next agent`、`## Role`、`## Reason`）。这避免了早期引入 JSON 格式约束，但 Markdown 解析天生不稳定——模型可能多输出空行、换措辞、少写章节。

Node 全栈实现 council engine 时，如果先实现 Markdown 解析再切换到 JSON，会有一次多余的返工。

### 决策

在 Step 3 Council Engine 中，coordinator 决策直接使用 JSON 格式：

```json
{
  "decision": "continue",
  "next_agent": "claude",
  "role": "从实现可行性角度挑战方案",
  "reason": "Codex 给出了设计方向，但没有评估实现成本"
}
```

同时设计兜底策略：
- JSON 解析失败 → 默认收束（`fallback_finalize`）
- agent 不存在 → 回退到可用 agent 列表中的第一个
- 超过最大轮数 → 强制收束
- 解析失败应记录 `coordinator_error` 事件

### 影响

- council_route.md、council_decide.md、council_finalize.md 的 prompt 模板需输出 JSON
- engine 使用 `JSON.parse` 解析，比 Markdown 正则稳定
- 错误处理路径在首次实现时就包含，不需要后续补丁
- 不再需要在"以后"做 Markdown → JSON 迁移

## 2026-05-26：Coordinator 决策暂时使用 Markdown

状态：已废弃（被 2026-05-27 JSON 决策取代）

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

### 废弃原因

在 Node 全栈实现 council engine 时，与其先实现 Markdown 解析再迁移，不如从零就用 JSON。prompt 模板改 JSON 格式成本很低，`JSON.parse` 也比 Markdown 正则解析稳定。迁移时机已到。

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
