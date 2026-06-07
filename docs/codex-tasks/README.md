# Codex Tasks

按顺序执行，不要跳跃，不要一次实现多个 milestone。

推荐分支：

```bash
git checkout -b productize/m1-local-api-security
```

建议顺序：

1. `milestone-1-local-api-security.md`
2. `milestone-2-tool-manifest-policy.md`
3. `milestone-3-realtime-bundles.md`
4. `milestone-4-codex-agent.md`
5. `milestone-5-packaging.md`
6. `milestone-6-tests-docs.md`

每个 milestone 完成后：

```bash
npm run build
git diff
git status
```

如果已添加测试脚本：

```bash
npm run check
```
