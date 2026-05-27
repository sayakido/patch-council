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

## Workbench 检查

Node 全栈工作台位于：

```text
apps/patchcouncil-ui
```

mock session 已预置，无需额外生成。

语法检查：

```bash
npm run check
```

集成测试（HTTP smoke + 13 council engine 测试）：

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
npm run runtime:claude
```

真实 CLI 检查不在默认检查里跑，因为它依赖本机安装、登录状态、网络和模型响应时间。

当前记录：

```text
npm run runtime:fake    已通过
npm run runtime:codex   已通过，验证 codex exec --json ... - 的 stdin 输入
npm run runtime:claude  已通过，验证 claude stream-json 和 argument 输入
```

在 Codex 桌面沙箱内，真实 CLI 可能因为认证、网络或 WinGet 安装目录权限失败；需要用与用户终端一致的非沙箱权限验证真实 CLI。

启动 Web 工作台：

```bash
npm run start
```

默认地址：

```text
http://127.0.0.1:8765          # chat 工作台
http://127.0.0.1:8765/config.html  # 配置页面
```

## Council Smoke Test (Python 原型)

运行：

```bash
aictl council "你觉得这个项目下一步应该优先改进什么？请简短讨论，不要修改文件"
```

预期行为：

```text
Codex 发言
-> coordinator 可能尝试收束
-> min_distinct_agents 策略可能强制另一个 agent 发言
-> Claude 参与
-> coordinator finalize
```

## Council Smoke Test (Node 全栈)

```bash
cd apps/patchcouncil-ui
node cli/cli.js council "你觉得这个项目下一步应该优先改进什么？请简短讨论"
```

预期 session 输出：

```text
.project-ai/sessions/<session-id>/
  transcript.jsonl  ← 唯一权威事件日志
  state.json        ← 派生状态快照
  transcript.md     ← 派生可读视图
```

预期最终 state 形态：

```json
{
  "session_id": "<session-id>",
  "status": "done",
  "phase": "finalized",
  "turn_count": 2,
  "distinct_agents": ["codex", "claude"],
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
