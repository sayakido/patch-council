# AI 上下文

这个文件是新开 AI 对话时首先要读的恢复入口。目标是让 AI 在最短时间内理解项目现状、设计约束和下一步工作。

## 项目概况

- 代码里的项目名目前是 `aictl`，工作区名是 `PatchCouncil`。
- 项目目标：编排多个本地 AI 命令行工具，探索轻量级多 AI 协作。
- 当前方向：从固定任务流水线，转向动态的 `council` 协调模型。
- **活跃实现**：Node Workbench（`apps/patchcouncil-ui`）是当前的主力产品路径。
- **参考实现**：`src/aictl/` 是历史 Python 原型/参考，不再添加新功能。Python 路径仅保留用于概念参考。

## 当前产品方向

- 当前主入口是本地 Web Workbench：

```bash
cd apps/patchcouncil-ui
npm run start
# http://127.0.0.1:8765
```

- Node CLI 保留为开发、调试和自动化入口，不再是用户主路径。
- Python `src/aictl/` 是历史原型/参考实现，不再承接新功能。
- 后续自然语言主入口应优先落在 Workbench 体验中，而不是恢复 Python CLI 主路径。
- 2026-05-28 的方向调整：Workbench 成为主入口，支持创建、观察、Host 插话、取消和 Continue/Fork council session。
- Node runtime adapter spike 已完成：fake runtime 矩阵 + 真实 Codex/Claude 检查已通过 Node adapter。
- `opencode` 已卸载，决定替换为 `claude`（Claude Code CLI）。Claude Code CLI 原生支持 `--output-format stream-json`，与 Codex 的 `--json` 一样可直接对接 adapter 的 JSONL 解析。
- Step 0 完成：`npm run runtime:claude` 验证通过（需 `--verbose` 配合 `--output-format stream-json`）。三个 runtime check 全部通过。
- Step 1 完成：engine/config.js（YAML 配置加载 + 默认值合并）、engine/prompts.js（`{{ variable }}` 模板替换）、4 个 council prompt 模板已从 Python 复制到 engine/prompts/。
- Step 1.5 完成：`runCliRuntime` 已支持 `input` / `input_mode`，`codex exec --json ... -` stdin 路径和 Claude `-p ... --output-format stream-json` argument 路径都已真实测通。
- Step 2+3+4+5 完成：council engine、session store、CLI 入口、Web UI 实时轮询全部交付。
- Workbench v1 完成并已合并：chat 工作台 UI（三栏布局）、host 控制（interjection / cancel）、session fork/continue（source metadata）、配置页面（`/config.html`）。
- Workplan v1 已实现：`done` session 可按需生成结构化 workplan，事件追加到 `transcript.jsonl`，状态通过 `has_workplan` / `workplan_status` 派生，不改变 `session_finished.outcome`。

## Council 模型

- `aictl council "主题"` 会启动一个只读的多 agent 讨论。
- `mode=design_council` starts with a single-agent brainstorming prelude, writes `docs/designs/...md`, commits it, then reuses the existing council loop for review.
- coordinator 负责判断下一轮应该由哪个 AI 发言。
- agent 发言顺序是动态的，不再硬编码为固定顺序。
- 每轮 agent 发言后，coordinator 判断继续讨论还是收束。
- 当前最多允许 3 轮 agent 发言。
- council 模式当前不应该修改项目文件。

## 当前 Council 流程

```text
用户主题
-> [mode=design_council 时] brainstorming prelude（单 agent 澄清提问）
-> [mode=design_council 时] 生成并 commit design draft
-> [mode=design_council 时] phase_transition brainstorming→discussion
-> coordinator route（选择第一个 agent）
-> 被选中的 AI agent 发言
-> [mode=design_council 且有 blocker] 触发 design revision
-> coordinator decide，判断继续或收束
-> 策略检查（min_distinct_agents、finalize gate、max_turns）
-> 可选的下一轮 AI agent 发言
-> coordinator finalize，输出最终总结
```

Host 可在运行中插入消息（interjection），下一轮 coordinator 路由时可见。Host 也可请求取消（cancel），engine 在当前 turn 完成后停止。

已完成的 session 不可修改。Continue 操作创建新 session（fork），通过 `source_session_id` 携带前序 session 摘要。

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
- `opencode` 已从计划中移除。`claude -p "message"` 是替代方案，原生支持 `--output-format stream-json --include-partial-messages`。
- Node adapter 的输入模式已对齐：Codex 使用 `input_mode: stdin`，Claude 使用 `input_mode: argument`。
- Council 后续应从黑箱 CLI 输出改成可观察事件流，实时展示 coordinator 决策、agent 发言、策略覆盖和错误处理。
- 事件模型分为两层：runtime events 表达底层 CLI 运行状态，council events 表达产品语义。不要把 Codex/Claude 的原始输出直接暴露成 council event。

## 当前 Prompt 文件

旧的固定顺序 council prompt 已删除：

```text
council_first.md
council_challenge.md
council_synthesis.md
```

当前有效的 council prompt（在 `engine/prompts/`）：

```text
council_route.md
council_agent_turn.md
council_decide.md
council_finalize.md
brainstorming_ask_or_draft.md
design_draft.md
design_revision.md
```

## 当前策略和限制

```yaml
council:
  min_distinct_agents: 2
  max_context_chars: 2500
  max_transcript_chars: 2500
  max_message_chars: 800
  finalize_gate_max_overrides: 2
```

- `min_distinct_agents: 2` 用于避免 council 过早退化成单 agent 回答。
- 如果 coordinator 想提前收束，但已发言的不同 agent 数还没达到要求，并且还没达到 `max_turns`，策略层可以强制选择一个尚未发言的 agent 继续。
- `finalize_gate_max_overrides: 2` 用于避免 finalize gate 在信息不足时无限继续讨论；达到上限且没有未发言 agent 时允许 fallback finalize，并记录未解决问题。
- 策略覆盖应该以 `coordinator (policy)` 形式写入 transcript。
- 新 session 的 `agent_turn_completed` 会包含 `signal`，其中 `content` 是展示用 analysis。Finalize gate 使用 latest signal per distinct agent 判断是否允许收束；`disagree + ready` 可以收束，但 final summary 应记录 disagreements。

## 已知约束

- PowerShell 可能把中文 Markdown 显示成乱码；文件本身是 UTF-8，读取时显式指定 UTF-8 即可。
- coordinator 决策直接使用 JSON。engine 已实现兜底策略（解析失败→coordinator_error、未知 agent→coordinator_error+abort、超过 max_turns→finalize）。

## 已验证命令

Python 原型：
```bash
python -m compileall -q src
aictl doctor
aictl council --help
```

这些命令仅用于检查历史 Python 原型，不代表当前产品主路径。

Node 全栈（`apps/patchcouncil-ui/`）：
```bash
npm run check            # 全部 JS 文件语法检查
npm run smoke            # HTTP smoke + 37 council engine 集成测试
npm run start            # Web UI（http://127.0.0.1:8765），含 chat 工作台 + /config.html
npm run runtime:fake     # fake runtime 矩阵
npm run runtime:codex    # 真实 Codex CLI 验证
npm run runtime:claude   # 真实 Claude CLI 验证
node cli/cli.js council "话题"   # 真实 council 讨论
```

## 下一步优先级

见 `docs/ROADMAP.md`。Workbench v1 和 Workplan v1 已交付并合并，下一步进入自然语言入口和分工执行方向。
