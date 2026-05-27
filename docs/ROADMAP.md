# 路线图

这个文件只记录当前和后续工作优先级，应保持简洁并及时更新。

## 现在

当前焦点：**Workbench v1**——Node 全栈 Web 工作台。

Workbench v1 状态：

- 设计完成
- 核心实现已完成（engine / session store / CLI / 实时轮询 / chat 工作台 / 配置页面 / session fork）
- UI 已交付（chat 工作台、创建/观察/打断/取消/继续会话、`/config.html`）

当前状态：

- ~~UI spike~~ ✓ 完成（已升级为 Workbench v1 chat 工作台）
- Runtime adapter spike 已完成（fake 矩阵 + `codex --help` 通过）
- `opencode` 已卸载，决定替换为 `claude`（Claude Code CLI）
- 两个 CLI 都有原生 JSON 流式输出：Codex `exec --json`、Claude `--output-format stream-json`
- ~~Step 0: Runtime Verification~~ ✓ 完成
- ~~Step 1: Engine Config & Prompts~~ ✓ 完成
- ~~Step 1.5: Adapter Input + Config Alignment~~ ✓ 完成
- ~~Step 2+3: Session Store + Council Engine~~ ✓ 完成
- ~~Step 4: CLI Entry Point~~ ✓ 完成
- ~~Step 5: UI Real-Time~~ ✓ 完成
- ~~Step 6: Workbench v1 (chat UI + config page + host controls + session fork)~~ ✓ 完成
- ~~Step 7: 文档收尾~~ ✓ 完成

Workbench v1 已合并到 master。以下为后续方向。

## 以后

1. （已完成：JSON 解析失败、未知 agent、最大轮数兜底已在 engine 中实现）
2. （已完成：13 个 council engine 集成测试覆盖关键场景）
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
