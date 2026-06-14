# Her Command Test Fixtures

用于验证 Her 的命令调用质量：

```text
utterance -> alias/bundle -> intent/tool -> args -> policy -> confirmation
```

每个 fixture 代表一条用户自然语言命令。建议实现 `npm run test:commands`，用 dry-run 方式测试，不实际执行副作用工具。

## 字段

- `id`: 唯一 ID
- `utterance`: 用户说的话
- `category`: media / desktop / file / document / browser / comms / system / alias / task / coding / clarification / negative
- `strictness`: strict / flexible / clarification / negative
- `expected.bundles`: 期望 bundle
- `expected.tool`: 期望工具；需要澄清时为 null
- `expected.args`: 期望关键参数
- `expected.requiresConfirmation`: 是否需要确认
- `expected.expectedPolicy`: allow / deny
- `accept`: 宽松匹配规则
