# PatchCouncil Workbench v1

PatchCouncil 的本地 council 工作台——一个基于 Web 的 chat 工作台，用于创建和控制多 AI council 会话。

用户能力：

- 创建新 council 会话并设定讨论主题
- 实时观察 coordinator 决策和 agent 发言
- 打断运行中的讨论
- 取消会话
- 继续已暂停的会话
- 通过 `/config.html` 配置 agent 和 council 参数

当前不做：

- 不默认调用真实 Codex/Claude（需手动配置 agent）
- 不做 WebSocket（当前使用增量轮询）

## 运行

```powershell
cd apps\patchcouncil-ui
npm run generate:mock
npm run start
```

打开：

```text
http://127.0.0.1:8765
```

## 检查

```powershell
npm run check
npm run smoke
npm run runtime:fake
```

真实 CLI 兼容性检查是手动入口，不在默认检查里跑：

```powershell
npm run runtime:codex
npm run runtime:claude
```

这些命令会调用本机真实 AI CLI，可能需要登录状态、网络或较长等待。

检查内容：

- `npm run runtime:fake` 覆盖正常完成、超时、进程崩溃、流式输出和纯文本输出。
- `npm run runtime:codex` 验证 `codex exec --json ... -` 可通过 stdin 接收输入。
- `npm run runtime:claude` 验证 Claude Code CLI `stream-json` 输出和 argument 输入模式。

## 目录

```text
src/events.ts                 TypeScript 事件类型设计
scripts/generate-mock-session.js
mock-sessions/                mock transcript.jsonl 和 state.json
public/                       静态 UI
server.js                     零依赖本地静态/mock API server
src/runtime/                  Node child_process runtime adapter spike
```

`server.js` 只是 spike 用的薄壳，用于让浏览器通过 HTTP 读取 mock session 文件。它不是最终 server 设计。
