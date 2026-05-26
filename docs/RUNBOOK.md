# 运行手册

这个文件记录检查项目时常用的实际命令。

## 本地检查

在仓库根目录运行：

```bash
python -m compileall -q src
aictl doctor
aictl council --help
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

预期最终 state 形态：

```json
{
  "status": "done",
  "stage": "finalized",
  "turn_count": 3
}
```

## Windows UTF-8 说明

如果 PowerShell 中中文 Markdown 显示为乱码，可以显式用 UTF-8 读取：

```powershell
Get-Content -Path docs\AI_CONTEXT.md -Encoding UTF8
```

当前文档都按 UTF-8 保存。
