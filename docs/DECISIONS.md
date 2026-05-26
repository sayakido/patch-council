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
