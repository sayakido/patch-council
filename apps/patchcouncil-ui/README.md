# PatchCouncil Workbench v1

PatchCouncil 的本地 council 工作台——一个基于 Web 的 chat 工作台，用于创建和控制多 AI council 会话。

用户能力：

- 创建新 council 会话并设定讨论主题
- 实时观察 coordinator 决策和 agent 发言（chat 气泡样式）
- 打断运行中的讨论（host interjection）
- 取消会话
- 继续已完成的会话（fork with source metadata）
- 通过 `/config.html` 配置 agent 和 council 参数
- 从已提交的 design artifact 生成 writing-plans 风格 Markdown workplan，经过 council review / revision，并在用户批准前不会进入执行
- Agent 发言包含结构化 signal，策略层用它降低过早收束风险

当前不做：

- 不默认调用真实 Codex/Claude（需手动配置 agent）
- 不做 WebSocket（当前使用增量 HTTP 轮询）

## 运行

```bash
cd apps/patchcouncil-ui
npm run start
# → 打开 http://127.0.0.1:8765
```

服务器默认监听 `127.0.0.1:8765`，可通过环境变量覆盖：
- `PATCHCOUNCIL_UI_PORT` — 端口号
- `PATCHCOUNCIL_UI_HOST` — 监听地址
- `PATCHCOUNCIL_FAKE_RUNTIME=1` — 使用 fake runtime（不调用真实 CLI）

mock session 已预置在 `mock-sessions/` 目录下，无需额外生成。

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions` | 列出所有 session |
| POST | `/api/sessions` | 创建新 council（body: `{topic, mode, source_session_id?}`） |
| POST | `/api/sessions/:id/interjections` | 向运行中 session 插入 host 消息 |
| POST | `/api/sessions/:id/cancel` | 请求取消运行中 session |
| GET | `/api/sessions/:id/events?since=N` | 获取 session 事件（支持增量轮询） |
| GET | `/api/config` | 获取当前配置 |
| POST | `/api/sessions/:id/workplan` | 为 done session 生成结构化 workplan |
| PUT | `/api/config` | 更新配置 |

## 检查

```bash
npm run check            # 全部 JS 文件语法检查
npm run smoke            # HTTP smoke + council engine 集成测试
npm run runtime:fake     # fake runtime 矩阵
npm run runtime:codex    # 真实 Codex CLI 验证
npm run runtime:claude   # 真实 Claude CLI 验证
```

## 目录

```text
apps/patchcouncil-ui/
├── engine/                     # 核心引擎
│   ├── council.js              # CouncilEngine（路由/决策/收束/取消）
│   ├── session-store.js        # Session 创建/读写/状态派生
│   ├── events.js               # 事件类型常量
│   ├── event-sink.js           # JsonlSink / StateSnapshotSink
│   ├── config.js               # YAML 配置加载/保存
│   ├── prompts.js              # Prompt 模板
│   └── workplan.js             # Workplan 生成、校验和 Brief 构建
├── cli/cli.js                  # CLI 入口（开发/调试用）
├── server.js                   # HTTP API 服务端
├── public/                     # Web UI 前端（vanilla JS + CSS）
│   ├── index.html              # 三栏 chat 工作台
│   ├── app.js                  # 工作台状态机 + 事件投影
│   ├── config.html             # 配置页面
│   ├── config.js               # 配置页面逻辑
│   └── styles.css              # 工作台样式
├── scripts/                    # 测试脚本
│   ├── smoke-test.js           # HTTP 集成测试
│   ├── council-smoke.js        # Council engine 集成测试（37 个场景）
│   ├── runtime-fake-check.js   # Fake runtime 矩阵
│   ├── runtime-real-check.js   # 真实 CLI 兼容性检查
│   └── generate-mock-session.js
├── src/runtime/                # Node child_process runtime adapter
│   ├── cli-adapter.js
│   └── resolve-command.js
└── mock-sessions/              # 预置 mock session 数据
```
