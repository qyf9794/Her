# Codex Tasks

按顺序执行，不要跳跃，不要一次实现多个 milestone。

推荐分支：

```bash
git checkout -b codex/her-agent-runtime-m0-m10
```

建议顺序：

新版 Her Agent Runtime 路线从 M0 开始：

0. `milestone-0-baseline-quality-gate.md`
1. `milestone-1-renderer-decomposition.md`
2. `milestone-2-tool-runtime-decomposition.md`
3. `milestone-3-policy-rich-confirmations.md`
4. `milestone-4-desktop-context-snapshot.md`
5. `milestone-5-task-timeline-artifacts.md`
6. `milestone-6-codex-review-flow.md`
7. `milestone-7-workflow-skills-memory.md`
8. `milestone-8-focus-workflow-packs.md`

原产品化路线历史顺序：

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
