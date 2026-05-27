# PatchCouncil

一个本地多 AI 协作编排器。通过 council 模式让多个 AI CLI（Codex、Claude）进行动态讨论、挑战和收束，产出结构化结论。

## 核心概念

不再是固定流水线（plan → implement → review）。council 模式下，coordinator 根据讨论状态动态选择下一个发言的 agent，策略层（如 `min_distinct_agents`）防止过早退化为单 agent 回答。

```text
用户主题
→ coordinator 路由（选择第一个 agent）
→ agent 发言
→ coordinator 判断继续/收束
→ 策略检查（min_distinct_agents、max_turns）
→ 循环，直到收束
→ coordinator 最终总结
```

当前 council 只读，不修改文件。讨论过程以结构化事件流写入 session 日志。

## 项目结构

```
PatchCouncil/
├── src/aictl/              # Python 原型（参考实现）
├── apps/patchcouncil-ui/   # Node 全栈（当前主力）
│   ├── engine/             # council.js / session-store.js / events.js / event-sink.js
│   ├── cli/cli.js          # CLI 入口
│   ├── server.js           # Web UI 服务端
│   ├── public/             # Web UI 前端（vanilla JS）
│   └── scripts/            # smoke tests / fake runtime
├── docs/                   # ARCHITECTURE.md / ROADMAP.md / DECISIONS.md / AI_CONTEXT.md / RUNBOOK.md
└── .project-ai/            # 项目级配置和 session 存储
    ├── config.yaml
    └── sessions/           # council session 产物
```

## 快速开始

### 依赖

- Node.js >= 18
- 可选：Python 3（Python 原型）、Codex CLI、Claude Code CLI

### 安装

```bash
cd apps/patchcouncil-ui
npm install
```

### 运行

主入口是 Web UI——用户通过浏览器创建和控制 council 会话：

```bash
cd apps/patchcouncil-ui
npm run start
# → 打开 http://127.0.0.1:8765
```

Web UI 支持创建、观察、打断、取消和继续 council 会话。配置页面位于 `/config.html`。

Node CLI 保留作为开发/调试入口，不在用户主路径上：

```bash
# 语法检查
npm run check

# 集成测试（HTTP smoke + 13 council engine 测试）
npm run smoke

# 运行 council 讨论（需要 Codex + Claude CLI 已安装和登录）
node cli/cli.js council "你的话题"
```

### Session 产物

每次 council 讨论生成：

```text
.project-ai/sessions/<session-id>/
├── transcript.jsonl   # 唯一权威事件日志
├── state.json         # 派生状态快照
└── transcript.md      # 人类可读视图
```

## Agent 配置

`.project-ai/config.yaml` 中配置可用 agent：

```yaml
agents:
  codex:
    command: codex
    args: [exec, --json, --sandbox, read-only, --ephemeral, "-"]
    input_mode: stdin
    capabilities: [plan, synthesize, review, judge]

  claude:
    command: claude
    args: [-p, --output-format, stream-json, --include-partial-messages, --verbose,
           --no-session-persistence, --permission-mode, bypassPermissions]
    input_mode: argument
    capabilities: [challenge, implement, fix]

council:
  max_turns: 3
  min_distinct_agents: 2
```

## 文档

| 文档 | 内容 |
|---|---|
| `docs/ARCHITECTURE.md` | 系统设计 |
| `docs/ROADMAP.md` | 当前进度和后续计划 |
| `docs/DECISIONS.md` | 项目决策记录 |
| `docs/AI_CONTEXT.md` | 新 AI 对话恢复入口 |
| `docs/COUNCIL_EVENTS.md` | 事件模型 schema |
| `docs/RUNBOOK.md` | 常用命令 |
