# 路线图

这个文件只记录当前和后续工作优先级，应保持简洁并及时更新。

## 现在

当前状态：

- UI spike 已完成（mock session list、discussion timeline、work/status panel）
- Runtime adapter spike 已完成（fake 矩阵 + `codex --help` 通过）
- `opencode` 已卸载，决定替换为 `claude`（Claude Code CLI）
- 两个 CLI 都有原生 JSON 流式输出：Codex `exec --json`、Claude `--output-format stream-json`
- ~~Step 0: Runtime Verification~~ ✓ 完成（fake / codex / claude 全部通过）
- ~~Step 1: Engine Config & Prompts~~ ✓ 完成（engine/config.js + engine/prompts.js + 4 个 council prompt 模板）

马上要做（按顺序）：

Step 1.5: Adapter Input + Config Alignment
  修正进入真实 council engine 前的前置能力：
    - 给 runCliRuntime 增加 input / input_mode 支持
    - 验证 codex exec --json ... stdin 路径，而不只是 codex --help
    - 同步 claude 默认 args 为 stream-json 参数
    - README 从 OpenCode 旧说法改成 Claude
    - 忽略 .claude/ 本地权限文件

Step 2+3: Session Store + Council Engine（先对齐接口，再分别实现）
  这两个模块互相依赖，先一起设计接口，再各自实现，避免返工。

  接口设计（先做）：
    - SessionStore 写入接口：createSession / appendEvent
    - CouncilEngine 事件发射接口：emit(event) 的 event 类型和字段
    - 对齐后确认两端不需要对方未定义的行为

  Step 2 实现：engine/session-store.js
    - createSession / appendEvent（每事件一行，立即 flush）
    - deriveState（从 jsonl 重建 state.json）
    - generateTranscript（从 jsonl 生成 transcript.md）
    - readEvents（按 seq 排序读取）

  Step 3 实现：engine/council.js + engine/event-sink.js
    - port council.py 的 loop 逻辑，使用 EventEmitter
    - JsonlSink / StateSnapshotSink / CliRendererSink
    - 引擎 fan-out: emit(event) → 三个 sink 各自消费
    - coordinator 决策直接使用 JSON（不从 Markdown 迁移）
    - 必须包含 fake runtime 集成测试，覆盖 council loop 状态机

Step 4: CLI Entry Point
  新建 cli/cli.js — 只实现 `council "topic"` 子命令
    session list/show/replay 已由 Web UI 覆盖，不重复实现

Step 5: UI Real-Time
  修改 server.js  — 增加 GET /api/sessions/:id/events?since=<seq> 增量轮询
  修改 public/app.js — running session 自动轮询（3s），新事件追加到 timeline

工作量预估：

| Step | 预估 | 状态 |
|---|---|---|
| 0. Runtime Verification | 15min | ✓ 完成 |
| 1. Config & Prompts | 30min | ✓ 完成 |
| 1.5. Adapter Input + Config Alignment | 30-45min | 当前 |
| 2+3. Session Store + Council Engine | 3-4h | |
| 4. CLI Entry | 15min | |
| 5. UI Real-Time | 30min | |
| **合计** | **5-6.5h** | |

## 以后

1. 为 JSON 解析失败、未知 agent、最大轮数处理增加兜底行为。
2. 给上下文压缩和 `min_distinct_agents` 策略补单元测试。
3. 讨论后生成结构化 workplan，但暂不自动执行。
4. 增加自然语言主入口：

```bash
aictl "自然语言请求"
```

5. 将自然语言请求路由到合适模式：

```text
回答
制定计划
审查
实现
追问用户
```

6. 当自然语言请求涉及修改文件时，要求用户有明确意图或进行二次确认。

7. 支持讨论后分工执行：

```text
discussion
-> task_assignment
-> execution
-> review
-> finalized
```

执行相关事件应继续追加到同一个 `transcript.jsonl`，保持 session 日志作为唯一事实来源。
