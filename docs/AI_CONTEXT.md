# AI 上下文

这个文件是新开 AI 对话时首先要读的恢复入口。目标是让 AI 在最短时间内理解项目现状、设计约束和下一步工作。

## 项目概况

- 代码里的项目名目前是 `aictl`，工作区名是 `PatchCouncil`。
- 项目目标：编排多个本地 AI 命令行工具，探索轻量级多 AI 协作。
- 当前方向：从固定任务流水线，转向动态的 `council` 协调模型。

## 当前产品方向

- 长期主入口希望接近：

```bash
aictl "自然语言请求"
```

- `plan`、`do`、`review`、`auto`、`continue` 这类显式命令暂时保留，用于调试、可重复工作流和底层控制。
- 近期优先级仍然是完善 `council` loop，然后再做自然语言主入口。
- 2026-05-27 的方向调整：如果目标是让用户看到 AI 讨论过程，主体验应转向本地可视化 UI，而不是继续在 Python CLI 上做复杂展示。
- Node/TypeScript UI spike 已完成：mock session list、discussion timeline 和 work/status panel 已跑通。
- Node runtime adapter spike 已完成：fake runtime 矩阵 + 真实 `codex --help` 已通过 Node adapter。
- `opencode` 已卸载，决定替换为 `claude`（Claude Code CLI）。Claude Code CLI 原生支持 `--output-format stream-json`，与 Codex 的 `--json` 一样可直接对接 adapter 的 JSONL 解析。
- 下一步：验证 `claude` 通过 runtime adapter（`npm run runtime:claude`），然后正式推进 Node 全栈实现。

## Council 模型

- `aictl council "主题"` 会启动一个只读的多 agent 讨论。
- coordinator 负责判断下一轮应该由哪个 AI 发言。
- agent 发言顺序是动态的，不再硬编码为固定顺序。
- 每轮 agent 发言后，coordinator 判断继续讨论还是收束。
- 当前最多允许 3 轮 agent 发言。
- council 模式当前不应该修改项目文件。

## 当前 Council 流程

```text
用户主题
-> coordinator route
-> 被选中的 AI agent 发言
-> coordinator decide，判断继续或收束
-> 可选的下一轮 AI agent 发言
-> coordinator finalize，输出最终总结
```

## 会话存储

Council 会话保存在：

```text
.project-ai/sessions/<session-id>/
  transcript.md
  transcript.jsonl
  state.json
```

- `transcript.jsonl`：唯一权威事件日志。
- `state.json`：从事件流派生的当前状态快照。
- `transcript.md`：从事件流渲染的人类可读视图。
- 会话产物默认不进入 git。

事件 schema 见 `docs/COUNCIL_EVENTS.md`。核心规则是：重要业务事实必须能从 `transcript.jsonl` 重建，`state.json` 和 `transcript.md` 都不应成为第二份真相。

## 重要实现决策

- 不为每一轮 AI 回复创建单独 Markdown 文件。
- 完整 transcript 保存在磁盘，但不要在每轮模型调用时重新塞入完整 transcript。
- 每轮模型输入只使用压缩后的 Council Brief。
- Windows 命令行长度有限，不能长期依赖一个超长命令行参数传递完整上下文。
- `opencode run "message"` 通过 argv 方式调用是可用的，但大消息仍然需要压缩。`claude -p "message"` 是替代方案，原生支持 `--output-format stream-json --include-partial-messages`。
- Council 后续应从黑箱 CLI 输出改成可观察事件流，实时展示 coordinator 决策、agent 发言、策略覆盖和错误处理。
- 事件模型分为两层：runtime events 表达底层 CLI 运行状态，council events 表达产品语义。不要把 Codex/Claude 的原始输出直接暴露成 council event。

## 当前 Prompt 文件

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

## 当前策略和限制

```yaml
council:
  min_distinct_agents: 2
  max_context_chars: 2500
  max_transcript_chars: 2500
  max_message_chars: 800
```

- `min_distinct_agents: 2` 用于避免 council 过早退化成单 agent 回答。
- 如果 coordinator 想提前收束，但已发言的不同 agent 数还没达到要求，并且还没达到 `max_turns`，策略层可以强制选择一个尚未发言的 agent 继续。
- 策略覆盖应该以 `coordinator (policy)` 形式写入 transcript。

## 已知约束

- PowerShell 可能把中文 Markdown 显示成乱码；文件本身是 UTF-8，读取时显式指定 UTF-8 即可。
- coordinator 决策当前使用 Markdown 章节，便于检查，但不如严格 JSON 稳定。
- 后续如果改为 JSON，需要设计解析失败、未知 agent、超过最大轮数等兜底策略。

## 已验证命令

当前迭代中已经跑通过：

```bash
python -m compileall -q src
aictl doctor
aictl council --help
```

加入上下文压缩后，也跑通过了一次真实 council smoke test。

## 下一步优先级

见 `docs/ROADMAP.md`。当前阶段：Node 全栈实现，详见路线图。
