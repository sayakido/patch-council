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
```

## 目录

```text
src/events.ts                 TypeScript 事件类型设计
scripts/generate-mock-session.js
mock-sessions/                mock transcript.jsonl 和 state.json
public/                       静态 UI
server.js                     零依赖本地静态/mock API server
```

`server.js` 只是 spike 用的薄壳，用于让浏览器通过 HTTP 读取 mock session 文件。它不是最终 server 设计。
