# Suggested Command Fixture Runner

建议新增：

```json
{
  "test:commands": "vitest run tests/command-fixtures.test.ts"
}
```

第一阶段不需要调用 OpenAI，可以只测：

1. AliasResolver
2. BundleRouter
3. intent_route dry-run / native router
4. Tool schema validation
5. Policy decision
6. Confirmation decision

伪代码：

```ts
for (const fixture of fixtures) {
  const route = routeCommand(fixture.utterance)
  expect(route.bundles).toMatchExpected(fixture)

  if (fixture.strictness === "clarification") {
    expect(route.needsClarification).toBe(true)
    continue
  }

  const intent = dryRunIntent(fixture.utterance, route.bundles)
  expect(intent.tool).toMatchExpectedTool(fixture)

  validateArgs(intent.args, fixture)
  validatePolicy(intent, fixture)
}
```
