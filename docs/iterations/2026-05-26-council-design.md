# 迭代记录：面向 Council 的 AI 协作设计

> 历史迭代记录。恢复当前项目上下文时，请先读 `../AI_CONTEXT.md`。

日期：2026-05-26

## 背景

这个项目目前叫 `aictl`，目标是编排本地多个 AI 命令行工具。最初的 MVP 采用显式工作流命令，例如 `plan`、`do`、`review`、`auto` 和 `continue`。

最初默认工作流是：

```text
Codex 起草计划
-> OpenCode 挑战计划
-> Codex 形成最终计划
-> OpenCode 执行实现
-> Codex 审查 git diff
-> 必要时 OpenCode 修复
-> 写入长期记忆
```

本轮讨论后，我们意识到：固定工作流适合确定性执行，但会限制多个 AI 之间的协作价值。项目方向开始从“固定流水线”转向“轻量的多 AI 讨论与协调系统”。

## 本轮讨论的问题

### 显式命令显得偏重

显式命令有价值，尤其适合调试、重复执行和精确控制。但如果把所有步骤都暴露为主要入口，工具会显得臃肿。

更理想的长期入口是：

```bash
aictl "自然语言请求"
```

显式步骤命令可以继续保留，但更适合成为高级入口或调试入口。

### 固定角色限制了 AI 能力

最初模型里，每个 AI 被固定到某些角色：

```text
Codex = 计划 / 审查 / 综合
OpenCode = 挑战 / 实现 / 修复
```

这样很可控，但也会压制 AI 根据上下文自行判断“此刻该做什么”的能力。我们真正想要的不是简单串联工具，而是让多个 AI 协作后产生 `1 + 1 > 2` 的效果。

### 第一版 council 仍然太线性

第一版 council 原型是：

```text
Codex 先给观点
-> OpenCode 挑战
-> Codex 总结
```

这比任务工作流更适合讨论，但发言顺序仍然是硬编码的，还不是真正的动态协作。

## 设计方向

我们决定改成由协调者控制的 council 循环。

不再固定谁先说、谁后说，而是：

```text
用户主题
-> 协调者判断下一位应该由谁发言
-> 被选中的 AI 发言
-> 协调者判断继续还是收束
-> 协调者输出最终总结
```

这样仍然保持轻量，但 agent 选择可以根据当前讨论状态动态发生。

## 当前已实现的 council 流程

现在 `aictl council "主题"` 内部流程是：

```text
协调者路由
-> 被选中的 AI 发言
-> 协调者判断继续或收束
-> 可选的下一轮 AI 发言
-> 协调者最终总结
```

第一版最多允许 3 轮 AI 发言，避免无限讨论。

当前 council 模式只读，不会编辑文件。

## 存储模型

我们决定不再为每个 AI 回复单独创建一个 Markdown 文件。聊天式协作如果每轮一个文件，会导致文件太碎，不利于阅读和回溯。

Council 会话统一保存到：

```text
.project-ai/sessions/<session-id>/
  transcript.md
  transcript.jsonl
  state.json
```

`transcript.md` 给人阅读。

`transcript.jsonl` 给后续程序处理。

`state.json` 记录会话状态、阶段和 turn 数。

会话产物默认不进入 git：

```gitignore
.project-ai/sessions/*
!.project-ai/sessions/.gitkeep
```

## 关键实现决策

### 暂时保留显式工作流

当前仍保留：

```text
plan
do
review
auto
continue
```

这些命令仍然适合调试、重复执行和底层控制。

未来可以考虑把它们收敛到更低层的命名空间下，但不应该直接删除能力。

### 使用协调者 prompt 替代固定 council prompt

旧的固定三段式 prompt 已删除：

```text
council_first.md
council_challenge.md
council_synthesis.md
```

当前有效的 council prompt 是：

```text
council_route.md
council_agent_turn.md
council_decide.md
council_finalize.md
```

### 暂不引入 JSON 路由

当前阶段，协调者用 Markdown 章节表达决策：

```text
## Decision
## Next agent
## Role
## Reason
```

这样实现更轻。后续如果需要更稳定的机器解析，再切换到严格 JSON。

### 需要显式显示模型运行状态

之前等待 AI 返回时，用户很难判断到底是在生成、重连，还是已经失败。

现在通用 CLI adapter 已改成流式读取子进程输出，并定期打印进度，例如：

```text
codex still running as council-route (30s elapsed). last stderr: ...
```

这样可以看到重连、重试和长时间生成的状态。

## 已做验证

本轮跑过这些本地检查：

```bash
python -m compileall -q src
aictl doctor
aictl council --help
```

还用 fake agent 做过端到端 smoke test，确认 coordinator loop 会写入：

```text
transcript.md
transcript.jsonl
state.json
```

也跑过一次真实 council：

```bash
aictl council "你觉得这个项目下一步应该优先改进什么？请简短讨论，不要修改文件"
```

这次真实运行成功生成了 session transcript。因为用户要求“简短讨论”，协调者只选择了 Codex 发言一轮，然后直接收束。

## 当前观察

### 协调者偏保守

真实测试里，协调者没有调用 OpenCode。这个行为可以理解：用户要求简短、只读，Codex 已经给出了足够结论。

但如果要验证多 AI 协作效果，不能让 council 经常退化成单 AI 回答。因此后续补充了最小不同 agent 参与策略：

```yaml
council:
  min_distinct_agents: 2
```

含义是：如果 coordinator 想提前收束，但已经发言的不同 agent 数还没达到 `min_distinct_agents`，并且还没达到 `max_turns`，系统会强制选择一个尚未发言的 agent 继续。

这个策略会在 transcript 中写入一条 `coordinator (policy)` 记录，说明为什么覆盖了 coordinator 的收束判断。

### 上下文膨胀与命令行长度限制

### Windows 中文显示仍需注意

文件内容按 UTF-8 写入，用 Python 按 UTF-8 读取是正常的。

但 PowerShell 的 `Get-Content` 在某些环境下会把中文显示成乱码。这更像是控制台显示问题，不是文件内容损坏。

### OpenCode 直接 run 可用

测试表明：

```bash
opencode run "message"
```

可以正常工作，只要通过 Python `subprocess.run([...])` 这类 argv 方式传参，避免 shell 多行引号干扰。

当前 OpenCode 配置已简化为：

```yaml
opencode:
  command: opencode
  args:
    - run
  input_mode: argument
```

之前临时使用的 `XDG_CONFIG_HOME` 覆盖已移除。

后续真实验证发现：当 council 进入多轮后，直接把完整项目上下文和完整 transcript 作为 `opencode run "message"` 的 message 传入，会在 Windows 上触发：

```text
The command line is too long.
```

这说明单纯依赖命令行参数传递完整上下文不可持续。

从工程演进角度看，单纯切换到 `--file` 只是绕过命令行长度限制，并没有解决 prompt 膨胀问题。更好的方向是引入 council 上下文压缩层。

当前已补充规则型压缩配置：

```yaml
council:
  max_context_chars: 2500
  max_transcript_chars: 2500
  max_message_chars: 800
```

实现策略是：

```text
完整 transcript 仍写入 transcript.md / transcript.jsonl
每轮模型输入只使用压缩后的 Council Brief
Council Brief 包含 topic、裁剪后的项目上下文、最近若干条消息和完整 transcript 路径
```

这样既保留完整回溯记录，又避免每轮 prompt 无限膨胀。

压缩后重新真实验证：

```bash
aictl council "你觉得这个项目下一步应该优先改进什么？请简短讨论，不要修改文件"
```

验证结果：

```text
Codex 发言
-> coordinator 想收束
-> min_distinct_agents policy 强制继续
-> OpenCode 成功参与
-> 后续继续讨论
-> coordinator finalize
```

最终状态：

```json
{
  "status": "done",
  "stage": "finalized",
  "turn_count": 3
}
```

这次没有再触发命令行过长错误，说明上下文压缩策略有效。

## 后续阶段建议

### 阶段二：结构化协调者输出

把 Markdown 决策改成 JSON：

```json
{
  "action": "continue",
  "agent": "opencode",
  "role": "挑战实现可行性",
  "reason": "Codex 给出了设计方向，但没有评估实现成本"
}
```

同时要有兜底策略：

```text
JSON 解析失败 -> 默认收束
agent 不存在 -> 回退到 Codex
超过最大轮数 -> 强制收束
```

### 阶段三：Agent 能力画像

在配置里增加 council 专用的 agent profile：

```yaml
council:
  max_turns: 3
  coordinator: codex
  agents:
    codex:
      strengths:
        - 结构化推理
        - 综合总结
        - 审查风险
    opencode:
      strengths:
        - 实现可行性
        - 本地上下文
        - 挑战方案
```

协调者可以根据这些能力画像选择下一位发言者。

### 阶段四：自然语言主入口

最终可以支持：

```bash
aictl "自然语言请求"
```

默认先进入 council/router 模式，而不是直接修改文件。

最终动作可以是：

```text
回答
制定计划
审查
实现
追问用户
```

涉及写文件时，应要求用户明确表达或二次确认。

## 当前建议

先继续完善 council loop，再做自然语言主入口。

Council loop 是验证“多个 AI 是否能比单个 AI 更强”的核心机制。自然语言入口应该建立在它之上，而不是反过来。

短期下一步建议：

```text
1. 给上下文压缩和 min_distinct_agents 策略补单元测试
2. 在 README 中补充 council 命令和配置说明
3. 再考虑把 coordinator 决策从 Markdown 改成 JSON
```
