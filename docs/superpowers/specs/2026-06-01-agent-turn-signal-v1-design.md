# Agent Turn Signal v1 设计

## 目标

Agent Turn Signal v1 的目标是降低 council 过早收束的概率，让“是否可以 finalize”不再只依赖 coordinator 的主观判断。

每个 agent 发言时必须同时给出结构化信号，明确自己的立场、收束准备度、阻塞项、同意点、分歧点和建议下一步。UI 继续展示自然语言分析，engine 和 policy 使用结构化 signal 判断讨论是否成熟。

## 非目标

Agent Turn Signal v1 不包含：

- 改变 Workbench 的主交互模型。
- 自动执行任务或修改文件。
- 引入固定阶段流水线，例如强制 `explore -> challenge -> synthesize`。
- 让用户手动填写 signal。
- 用复杂语义模型二次判定每段自然语言。
- 替代 coordinator。Coordinator 仍负责路由和提议 finalize，但不再单独决定是否允许收束。
- 让 `council_decide.md` 在 v1 输出完整 signal。Coordinator structured rationale 留作后续方向。

## 问题背景

当前流程中，coordinator 在每轮 agent 发言后判断：

```text
continue or finalize
```

现有 policy 主要约束：

```text
min_distinct_agents
max_turns
```

这只能避免 council 退化成单 agent 回答，不能避免“两个 agent 简短发言后过早收束”。如果 coordinator 和某个参与 agent 都是同一个 LLM，例如 Codex，同时承担发言者和裁判角色，过早收束风险会更明显。

## 核心设计

Agent turn 输出从纯文本升级为结构化 JSON：

```json
{
  "stance": "agree",
  "confidence": "medium",
  "finalize_readiness": "ready",
  "blockers": [],
  "agreements": [],
  "disagreements": [],
  "recommended_next_step": "string",
  "analysis": "markdown string"
}
```

Engine 解析该 JSON 后，把 `analysis` 作为展示用内容，把其余字段保存为 `agent_turn_completed.signal`。

事件形态：

```json
{
  "schema_version": 1,
  "seq": 8,
  "type": "agent_turn_completed",
  "phase": "discussion",
  "session_id": "20260601-abc123",
  "turn": 2,
  "agent": "claude",
  "content": "自然语言分析 Markdown...",
  "content_length": 1200,
  "duration_ms": 18420,
  "signal": {
    "stance": "mixed",
    "confidence": "medium",
    "finalize_readiness": "not_ready",
    "blockers": [
      {
        "type": "question",
        "text": "失败后是否允许重试？"
      }
    ],
    "agreements": ["Workplan 应作为 finalized discussion 的派生产物"],
    "disagreements": ["不建议把 state.outcome 改成 workplan_created"],
    "recommended_next_step": "先确认 session 不变性规则"
  }
}
```

## Signal Schema

### stance

取值：

```text
agree
disagree
mixed
```

含义：

- `agree`：总体同意当前方向。
- `disagree`：总体不同意当前方向，或认为主要结论应改变。
- `mixed`：部分同意，但仍有重要取舍或风险。

`stance` 只表达立场，不表达信息是否足够。一个 agent 可以同意当前方向，同时认为还不能 finalize。

### confidence

取值：

```text
low
medium
high
```

`confidence` 表示 agent 对自己本轮判断的把握，而不是对最终方案的投票。

v1 中 `confidence` 只用于 UI、`transcript.md` 和后续分析，不参与 finalize gate。

### finalize_readiness

取值：

```text
ready
not_ready
```

- `ready`：agent 认为如果没有其他 agent 提出 blocker，当前讨论可以收束。
- `not_ready`：agent 认为仍有阻塞项，或信息不足以收束。

`finalize_readiness` 和 `stance` 是独立维度。例如：

```json
{
  "stance": "agree",
  "finalize_readiness": "not_ready",
  "blockers": [
    {
      "type": "question",
      "text": "还需要确认失败后是否允许重试。"
    }
  ]
}
```

这表示 agent 同意方向，但认为还有阻塞问题。

### blockers

对象数组。只要进入 `blockers`，就表示该问题不解决不应 finalize。

```json
[
  {
    "type": "issue",
    "text": "尚未确认 session 是否允许多个成功 workplan。"
  },
  {
    "type": "question",
    "text": "失败后是否允许重试？"
  }
]
```

`type` 取值：

```text
issue
question
```

非阻塞问题不进入 `blockers`。v1 不单独结构化非阻塞问题；它们可以写进 `analysis` 或 `recommended_next_step`。

### agreements / disagreements

字符串数组，分别记录本轮明确同意和不同意的点。

不同意不等于不能 finalize。只要没有 blocker，且分歧已经被最终总结记录或转化为明确取舍，仍可以收束。

### recommended_next_step

字符串。表示 agent 认为下一步应该做什么。可以是继续讨论某个问题、让另一个 agent 回应、收束总结、或请求用户确认。

### analysis

Markdown 字符串。用于 UI chat 气泡和 `transcript.md` 的主要可读内容。

`analysis` 不能为空。如果模型只给 signal 而没有分析，engine 应把完整原始输出作为 content，并记录降级原因。

## Prompt 变化

修改 `engine/prompts/council_agent_turn.md`，要求 agent 只输出严格 JSON，不使用 Markdown fence。

Prompt 需强调：

- 你是在参与 council 讨论，不是在执行任务。
- 必须给出结构化 signal。
- `analysis` 是给用户阅读的自然语言发言。
- `stance` 和 `finalize_readiness` 是独立维度。
- 如果同意方向但仍缺少关键信息，使用 `stance: "agree"` 和 `finalize_readiness: "not_ready"`，并把阻塞问题写入 `blockers`。
- 如果不同意，说明分歧是否阻塞 finalize。
- 不要为了礼貌写 `agree`。如果只有部分同意，使用 `mixed`。
- `blockers` 只放不解决就不应收束的问题。

目标 prompt 草案：

```markdown
你是多 agent council 的参与者。

当前阶段只讨论，不编辑文件，不执行命令。

你的任务是针对本轮角色发表观点，并输出一个严格 JSON 对象。不要输出 Markdown 代码块，不要输出 JSON 之外的文字。

`analysis` 是给用户阅读的自然语言发言，必须有实质内容。
`stance` 只表达你对当前方向的立场。
`finalize_readiness` 表达你是否认为当前讨论已经可以收束。
你可以同意方向，但仍认为不能收束：此时使用 `"stance": "agree"` 和 `"finalize_readiness": "not_ready"`。

`blockers` 只放不解决就不应 finalize 的问题。非阻塞注意事项写进 `analysis` 或 `recommended_next_step`。
不要为了礼貌写 agree。如果只有部分同意，使用 mixed。

请只返回如下 JSON：

{
  "stance": "agree | disagree | mixed",
  "confidence": "low | medium | high",
  "finalize_readiness": "ready | not_ready",
  "blockers": [
    { "type": "issue | question", "text": "string" }
  ],
  "agreements": ["string"],
  "disagreements": ["string"],
  "recommended_next_step": "string",
  "analysis": "markdown string"
}
```

## 解析与降级

Engine 在 `runAgentTurn` 中解析 agent 输出。

成功解析：

```text
agent_turn_completed.content = parsed.analysis
agent_turn_completed.signal = parsed without analysis
```

解析失败：

```text
agent_turn_completed.content = raw model output
agent_turn_completed.signal = fallback signal
agent_turn_completed.signal_parse_error = "failed to parse agent turn signal JSON"
```

fallback signal：

```json
{
  "stance": "mixed",
  "confidence": "low",
  "finalize_readiness": "not_ready",
  "blockers": [
    {
      "type": "issue",
      "text": "Agent response did not provide a parseable deliberation signal."
    }
  ],
  "agreements": [],
  "disagreements": [],
  "recommended_next_step": "Continue discussion with a parseable structured response."
}
```

这样 JSON 解析失败不会被误判为可以 finalize。

## Finalize Gate v1

Coordinator 仍然可以输出：

```json
{
  "decision": "finalize",
  "next_agent": null,
  "role": null,
  "reason": "..."
}
```

但 engine 必须在允许 finalize 前检查 `agent_turn_completed.signal`。

第一版 gate：

```text
1. latest signal per distinct agent 的数量 >= min_distinct_agents
2. 所有 latest signals 的 blockers 为空
3. 不允许所有 latest signals 都是 finalize_readiness=not_ready
4. 如果存在 stance=disagree 且 finalize_readiness=not_ready，则不允许 finalize
5. stance=disagree 但 finalize_readiness=ready 可以 finalize，但 final summary 必须记录 disagreements
```

`latest signal per distinct agent` 表示每个参与过的 agent 只取最新一次 signal。这样旧 blocker 可以被该 agent 后续发言覆盖，不会永久卡住 session。

`buildBrief()` 必须把每个 `agent_turn_completed.signal` 摘要写入给 `council_finalize.md` 的 transcript，至少包含 `stance`、`confidence`、`finalize_readiness`、`blockers`、`agreements`、`disagreements` 和 `recommended_next_step`。否则 final summary 无法可靠执行“记录 ready disagreement”的要求。

不满足时，写入 `policy_override`：

```json
{
  "type": "policy_override",
  "policy": "finalize_gate",
  "original_decision": "finalize",
  "new_decision": "continue",
  "selected_agent": "claude",
  "reason": "blocker remains: 失败后是否允许重试？"
}
```

然后选择下一位 agent 继续讨论。

## 防卡死机制

Finalize gate 不能让 council 无限循环。v1 增加确定性 escape hatch：

```yaml
council:
  finalize_gate_max_overrides: 2
```

规则：

```text
如果 finalize gate 连续拒绝 coordinator 的 finalize 申请达到 finalize_gate_max_overrides，
并且没有尚未发言的 enabled agent 可以补充视角，
engine 允许 fallback finalize。
```

fallback finalize 必须记录未解决 blockers：

```text
summary: 说明讨论未完全收敛
next_steps: 包含未解决 blockers 和建议用户确认的问题
```

同时，`policy_override.reason` 或 finalized metadata 必须说明这是 fallback finalize，而不是无阻塞收束。

这样可以避免两类坏情况：

- agent 一直保守，导致 council 空转。
- 真实缺信息时，系统无限继续讨论而不是把问题交还给用户。

## 继续讨论的 agent 选择

当 finalize gate 拒绝收束时，agent 选择规则：

1. 如果存在尚未发言的 enabled agent，优先选择尚未发言者。
2. 否则选择第一个 enabled 且不是 coordinator 的 agent。
3. 如果只有 coordinator 可用，则允许 coordinator 作为 agent 继续，但 `policy_override.reason` 必须记录该退化。

v1 不根据 `disagree`、`not_ready` 或 blocker 类型做复杂 agent selection。该类语义路由留到后续版本。

## Coordinator 和参与者分离

Agent Turn Signal v1 不禁止 coordinator 作为 agent 发言，但加入轻量策略：

```text
如果 enabled agent 数 > 1，首轮 route 应优先选择非 coordinator agent。
```

这样减少“同一个 LLM 自己发言、自己裁判、自己收束”的情况。

该策略属于 v1 范围，应与 finalize gate 一起实现。

## UI

主线程 chat 仍展示：

```text
agent_turn_completed.content
```

也就是 `analysis`。

Workbench v1 不需要把 signal 做成复杂表格。第一版 UI 可以只增加轻量标记：

```text
stance · confidence · readiness
```

例如：

```text
mixed · medium confidence · not ready
```

Raw events 继续显示完整 signal。

错误或 fallback signal 不应隐藏。如果 `signal_parse_error` 存在，主线程可以展示一个紧凑系统提示：

```text
Agent signal parse failed; continuing discussion.
```

## Transcript

`transcript.md` 渲染 agent turn 时：

```markdown
## claude (turn 2)

**Stance:** mixed
**Confidence:** medium
**Readiness:** not_ready
**First blocker:** 失败后是否允许重试？

自然语言 analysis...
```

不需要完整展开所有 signal 字段，完整结构仍以 `transcript.jsonl` 为准。

## 测试策略

Engine tests：

- 合法 agent JSON 输出被解析为 `content + signal`。
- Markdown fence 包裹的 JSON 也能解析。
- 非 JSON 输出生成 fallback signal，且包含 `signal_parse_error`。
- fallback signal 会阻止 finalize。
- 有 blocker 时 coordinator finalize 被 `policy_override` 为 continue。
- 全部 latest signals 为 `finalize_readiness=not_ready` 时不允许 finalize。
- `disagree + not_ready` 时不允许 finalize。
- `disagree + ready` 且无 blocker 时允许 finalize。
- 连续 finalize gate override 达到 `finalize_gate_max_overrides` 且没有未发言 agent 时 fallback finalize。
- enabled agent 数大于 1 时，首轮 route 不优先选择 coordinator 自己。

Prompt tests：

- `council_agent_turn.md` 包含 signal schema。
- prompt 明确要求 strict JSON。
- prompt 明确禁止把部分同意写成纯 `agree`。
- prompt 明确说明 `stance` 和 `finalize_readiness` 是独立维度。

UI / transcript tests：

- agent bubble 展示 `analysis` 而不是完整 JSON。
- signal stance/confidence/readiness 可见或至少不破坏现有 chat 渲染。
- raw events 显示完整 signal。
- `transcript.md` 包含 stance/confidence/readiness/first blocker。

## 兼容性

旧 session 的 `agent_turn_completed` 没有 `signal` 字段。读取旧 session 时：

- UI 继续展示 `content`。
- state 派生不要求 signal。
- replay 不报错。
- finalize gate 只影响新运行的 session。

## 实现同步点

实现该 spec 时必须同步更新：

- `docs/COUNCIL_EVENTS.md` 中的 `agent_turn_completed` schema。
- `apps/patchcouncil-ui/engine/events.js` 中的 `agentTurnCompleted()` 函数签名。
- `apps/patchcouncil-ui/engine/session-store.js` 的 `transcript.md` 渲染。
- UI 的 agent bubble 投影，确保展示 `analysis` 而不是完整 JSON。

## 后续方向

第一版暂不引入独立 `agent_signal_recorded` 事件，直接扩展 `agent_turn_completed.signal`。如果未来 signal 需要单独审计、重算或用户编辑，再考虑拆成独立事件。

第一版不做复杂自然语言语义判断。成熟度判断只基于 agent 自报 signal 和简单 policy gate。

第一版不要求 `council_decide.md` 输出 signal。如果后续发现 coordinator 频繁提出 finalize 且频繁被 gate override，可以让 coordinator decision 增加结构化收束理由：

```json
{
  "decision": "finalize",
  "reason": "string",
  "readiness_evidence": ["string"],
  "known_blockers": ["string"],
  "unresolved_disagreements": ["string"]
}
```

这不是 agent signal，而是 coordinator structured rationale，用于调试 coordinator 为什么认为可以收束。
