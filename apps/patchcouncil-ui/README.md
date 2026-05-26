# PatchCouncil UI Spike

这是 PatchCouncil 的本地可视化 UI spike。

当前目标：

- 用 mock council events 验证可视化方向；
- 展示 session list；
- 展示 discussion timeline；
- 展示 work/status panel；
- 验证 runtime events / council events 双层模型在 UI 侧是否顺手。

当前不做：

- 不接真实 Codex/OpenCode；
- 不做 WebSocket；
- 不做复杂持久化；
- 不重写现有 Python council loop。
- 不默认调用真实 Codex/OpenCode。

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
npm run runtime:opencode
```

这些命令会调用本机真实 AI CLI，可能需要登录状态、网络或较长等待。

当前验证记录：

- `npm run runtime:fake` 覆盖正常完成、超时、进程崩溃、流式输出和纯文本输出。
- `npm run runtime:codex` 已验证 `codex --help` 可通过 Node adapter 解析 `.cmd` 并流式读取。
- `npm run runtime:opencode` 依赖本机 PATH 中存在 `opencode`，当前未纳入默认检查。

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
