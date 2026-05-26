# 路线图

这个文件只记录当前和后续工作优先级，应保持简洁并及时更新。

## 现在

1. 给 council 上下文压缩补单元测试。
2. 给 `min_distinct_agents` 策略补单元测试。
3. 在 `README` 中补充 `aictl council` 用法和 council 配置说明。

## 接下来

1. 把 coordinator 决策从 Markdown 章节改为严格 JSON。
2. 为 JSON 解析失败、未知 agent、最大轮数处理增加兜底行为。
3. 增加 council 专用的 agent 能力画像配置。

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

1. 增加自然语言主入口：

```bash
aictl "自然语言请求"
```

2. 将自然语言请求路由到合适模式：

```text
回答
制定计划
审查
实现
追问用户
```

3. 当自然语言请求涉及修改文件时，要求用户有明确意图或进行二次确认。
