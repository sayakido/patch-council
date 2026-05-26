# 运行手册

这个文件记录检查项目时常用的实际命令。

## 本地检查

在仓库根目录运行：

```bash
python -m compileall -q src
aictl doctor
aictl council --help
```

这些命令检查当前 Python 原型。

## UI Spike 检查

Node/TypeScript UI spike 位于：

```text
apps/patchcouncil-ui
```

生成 mock session：

```bash
npm run generate:mock
```

做语法检查：

```bash
npm run check
```

做 HTTP smoke test：

```bash
npm run smoke
```

验证 Node runtime adapter fake 矩阵：

```bash
npm run runtime:fake
```

手动验证真实 CLI：

```bash
npm run runtime:codex
npm run runtime:opencode
```

真实 CLI 检查不在默认检查里跑，因为它依赖本机安装、登录状态、网络和模型响应时间。

启动本地 UI：

```bash
npm run start
```

默认地址：

```text
http://127.0.0.1:8765
```

## Council Smoke Test

运行：

```bash
aictl council "你觉得这个项目下一步应该优先改进什么？请简短讨论，不要修改文件"
```

预期行为：

```text
Codex 发言
-> coordinator 可能尝试收束
-> min_distinct_agents 策略可能强制另一个 agent 发言
-> OpenCode 参与
-> coordinator finalize
```

预期 session 输出：

```text
.project-ai/sessions/<session-id>/
  transcript.md
  transcript.jsonl
  state.json
```

存储职责：

```text
transcript.jsonl 是唯一权威事件日志
state.json 是派生状态快照
transcript.md 是派生可读视图
```

预期最终 state 形态：

```json
{
  "session_id": "<session-id>",
  "status": "done",
  "phase": "finalized",
  "turn_count": 3,
  "distinct_agents": ["codex", "opencode"],
  "outcome": "discussion_only",
  "error_count": 0
}
```

## Windows UTF-8 说明

如果 PowerShell 中中文 Markdown 显示为乱码，可以显式用 UTF-8 读取：

```powershell
Get-Content -Path docs\AI_CONTEXT.md -Encoding UTF8
```

当前文档都按 UTF-8 保存。
