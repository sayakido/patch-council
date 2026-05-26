# 路线图

这个文件只记录当前和后续工作优先级，应保持简洁并及时更新。

## 现在

当前状态：

- UI spike 已完成（mock session list、discussion timeline、work/status panel）
- Runtime adapter spike 已完成（fake 矩阵 + `codex --help` 通过）
- `opencode` 已卸载，决定替换为 `claude`（Claude Code CLI）
- 两个 CLI 都有原生 JSON 流式输出：Codex `--json`、Claude `--output-format stream-json`

马上要做（按顺序）：

1. 验证 `claude` CLI 通过 runtime adapter：`npm run runtime:claude`
2. 全部 runtime check 通过后，进入 Node 全栈实现：

```text
Step 0: Runtime Verification
  - npm run runtime:fake（已有）
  - npm run runtime:codex（已有）
  - npm run runtime:claude（新增，claude -p "..." --output-format stream-json ...）

Step 1: Engine Config & Prompts
  新建 engine/config.ts  — 配置加载 + 默认值合并，agent 配置 codex + claude
  新建 engine/prompts.ts — {{ variable }} 模板替换，替代 Jinja2
  复制 src/aictl/prompts/council_*.md → engine/prompts/

Step 2: Session Store
  新建 engine/session-store.ts
    - createSession / appendEvent（每事件一行，立即 flush）
    - deriveState（从 jsonl 重建 state.json）
    - generateTranscript（从 jsonl 生成 transcript.md）
    - readEvents（按 seq 排序读取）

Step 3: Council Engine
  新建 engine/council.ts  — port council.py 的 loop 逻辑，使用 EventEmitter
  新建 engine/event-sink.ts — JsonlSink / StateSnapshotSink / CliRendererSink
  引擎 fan-out: emit(event) → 三个 sink 各自消费

Step 4: CLI Entry Point
  新建 cli/cli.ts — 只实现 `council "topic"` 子命令
    session list/show/replay 已由 Web UI 覆盖，不重复实现

Step 5: UI Real-Time
  修改 server.js  — 增加 GET /api/sessions/:id/events?since=<seq> 增量轮询
  修改 public/app.js — running session 自动轮询（3s），新事件追加到 timeline
```

工作量预估：

| Step | 预估 |
|---|---|
| 0. Runtime Verification | 15min |
| 1. Config & Prompts | 30min |
| 2. Session Store | 45min |
| 3. Council Engine | 1.5-2h |
| 4. CLI Entry | 10min |
| 5. UI Real-Time | 30min |
| **合计** | **3.5-4h** |

## 以后

1. 把 coordinator 决策从 Markdown 章节改为严格 JSON。
2. 为 JSON 解析失败、未知 agent、最大轮数处理增加兜底行为。
3. 给上下文压缩和 `min_distinct_agents` 策略补单元测试。
4. 讨论后生成结构化 workplan，但暂不自动执行。
5. 增加自然语言主入口：

```bash
aictl "自然语言请求"
```

6. 将自然语言请求路由到合适模式：

```text
回答
制定计划
审查
实现
追问用户
```

7. 当自然语言请求涉及修改文件时，要求用户有明确意图或进行二次确认。

8. 支持讨论后分工执行：

```text
discussion
-> task_assignment
-> execution
-> review
-> finalized
```

执行相关事件应继续追加到同一个 `transcript.jsonl`，保持 session 日志作为唯一事实来源。
