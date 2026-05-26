# 路线图

这个文件只记录当前和后续工作优先级，应保持简洁并及时更新。

## 现在

1. 解决当前 shell 找不到 `opencode` 的问题。
2. 跑通 `npm run runtime:opencode`，验证 Node adapter 对 OpenCode 的真实兼容性。
3. 如果 OpenCode 验证通过，继续 Node 全栈方向。
4. 如果 OpenCode 验证不稳定，选择 Python engine + Node UI，以 `transcript.jsonl` 作为语言边界。

## 接下来

1. 如果 checkpoint 选择继续 Node 全栈，实现 session store：

```text
transcript.jsonl
state.json
transcript.md
```

2. 实现 council orchestrator spike：

```text
Codex/OpenCode raw output
-> runtime events
-> council events
```

3. 让 `transcript.jsonl` 成为唯一权威日志，`state.json` 和 `transcript.md` 改为派生视图。
4. 增加 `aictl session replay <id>` 或 UI replay。
5. 给 council 上下文压缩和 `min_distinct_agents` 策略补单元测试。

未来 agent profile 形态示例：

```yaml
council:
  agents:
    codex:
      strengths:
        - 结构化推理
        - 综合总结
        - 风险审查
    opencode:
      strengths:
        - 实现可行性
        - 本地项目上下文
        - 挑战假设
```

## 以后

1. 把 coordinator 决策从 Markdown 章节改为严格 JSON。
2. 为 JSON 解析失败、未知 agent、最大轮数处理增加兜底行为。
3. 增加 council 专用的 agent 能力画像配置。
4. 讨论后生成结构化 workplan，但暂不自动执行。
5. 增加自然语言主入口：

```bash
aictl "自然语言请求"
```

6. 将自然语言请求路由到合适模式：

```text
回答
制定计划
审查
实现
追问用户
```

7. 当自然语言请求涉及修改文件时，要求用户有明确意图或进行二次确认。

8. 支持讨论后分工执行：

```text
discussion
-> task_assignment
-> execution
-> review
-> finalized
```

执行相关事件应继续追加到同一个 `transcript.jsonl`，保持 session 日志作为唯一事实来源。
