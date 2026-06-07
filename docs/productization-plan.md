# Her 产品级改造实施计划

## 0. 总目标

把 Her 从当前的 Electron + Vite + GPT Realtime MVP，升级为一个产品级本地 AI Agent 平台。

核心定位：

```text
Her = Realtime 语音入口
    + 本地 Agent Runtime
    + Policy / Permission Engine
    + Tool Runtime
    + Confirmation UI
    + Codex 子代理托管层
```

不要把 Her 做成 “Realtime 的薄壳”。Realtime 负责实时理解、对话、工具调用决策；Her 负责本地权限、安全执行、确认、审计、工具路由、桌面能力、Codex 子代理和产品分发。

## 1. 当前判断

当前项目已经具备 MVP 闭环：

- Electron 桌面容器。
- Vite Renderer。
- 本地 Express API。
- GPT Realtime WebRTC 语音会话。
- 本地工具执行。
- Capability / App permission / YOLO mode。
- Confirmation queue。
- 文件、文档、邮件、日历、文案、音乐、视频、App、窗口、系统、剪贴板、浏览器、shell 工具。

当前主要产品化风险：

- 本地 HTTP API 安全边界不足。
- Renderer 承担了过多 runtime 逻辑。
- 工具定义分散在 shared / main / renderer 多处。
- Confirmation 还是静态工具名集合，不是通用 Policy Engine。
- Realtime session 当前倾向全量工具常驻，不适合长期扩展。
- Codex 还不应作为普通 shell command 接入。
- Electron 缺少签名、notarization、自动更新、打包分发基础设施。
- 缺少系统化测试与回归 checklist。

## 2. 产品化原则

- 分阶段、小步提交，不做一次性大爆炸重写。
- 每个 Milestone 完成后必须保持 `npm run build` 可用。
- Renderer 不再承担安全边界职责。
- 安全、权限、工具执行必须在 main/server/runtime 层。
- 工具定义必须单一来源。
- Codex 不能作为普通 shell command 调用；必须作为异步 coding-agent task 接入。
- 所有高风险动作必须经过 Her Policy Engine。
- YOLO mode 不能默认绕过 shell、browser submit、external send、system change、coding-agent。
- 不要在日志、Renderer、Codex 子进程或工具输出里泄露 secrets。

## 3. 目标架构

```text
src/
  main/
    app/
      create-window.ts
      protocol.ts
      security.ts
      lifecycle.ts

    api/
      server.ts
      auth.ts
      cors.ts
      routes/
        settings.routes.ts
        apps.routes.ts
        realtime.routes.ts
        tools.routes.ts
        confirmations.routes.ts
        agents.routes.ts

    agent/
      realtime-session-service.ts
      realtime-event-router.ts
      tool-call-runner.ts
      tool-bundle-router.ts
      response-state.ts

    policy/
      permission-engine.ts
      approval-policy.ts
      risk-classifier.ts
      audit-log.ts

    tools/
      define-tool.ts
      registry.ts
      manifest.ts
      bundles.ts
      filesystem/
      documents/
      comms/
      media/
      desktop/
      browser/
      shell/

    agents/
      coding-agent/
        types.ts
        task-store.ts
        codex-exec-runner.ts
        codex-app-server-runner.ts
        worktree-manager.ts
        env-sanitizer.ts
        approval-bridge.ts
        artifact-store.ts

    settings/
      settings-store.ts
      app-inventory.ts

  renderer/
    app.ts
    api/
      local-client.ts
    realtime/
      webrtc-client.ts
      event-client.ts
    state/
      session-store.ts
      settings-store.ts
      confirmation-store.ts
      agent-task-store.ts
    components/
      voice-orb.ts
      transcript.ts
      confirmation-panel.ts
      permission-panel.ts
      tool-activity-panel.ts
      agent-runs-panel.ts
    views/
      onboarding-view.ts
      main-view.ts

  shared/
    protocol/
      events.ts
      api.ts
    tools/
      types.ts
      schemas.ts
    settings/
      app-settings.ts
    agents/
      coding-agent.ts
```

## 4. 改造板块

### 板块 1：项目结构产品化重组

目标：

把当前项目从 “Electron main + 单文件 Renderer + ToolRegistry 巨文件” 改成清晰分层架构。

子计划：

1. 拆分 Renderer：
   - `renderer/api/local-client.ts`
   - `renderer/realtime/webrtc-client.ts`
   - `renderer/components/voice-orb.ts`
   - `renderer/components/transcript.ts`
   - `renderer/components/confirmation-panel.ts`
   - `renderer/components/permission-panel.ts`
   - `renderer/views/onboarding-view.ts`
   - `renderer/views/main-view.ts`

2. 拆分 main/server：
   - `api/server.ts`
   - `api/auth.ts`
   - `api/cors.ts`
   - `api/routes/*.routes.ts`

3. 拆分 ToolRegistry：
   - `tools/define-tool.ts`
   - `tools/manifest.ts`
   - `tools/registry.ts`
   - `tools/bundles.ts`
   - domain manifests

验收目标：

- `npm run build` 通过。
- `npm run dev` 可以启动。
- 现有语音连接仍可建立。
- 至少 `system_status`、`file_list`、`app_open`、`window_list`、`confirmation_list` 可调用。
- `src/renderer/main.ts` 只保留 bootstrap，目标小于 200 行。
- `src/main/server.ts` 只保留 server bootstrap 或兼容导出，目标小于 120 行。

### 板块 2：本地 API 安全边界改造

目标：

本地工具 API 不能被任意网页通过 `http://127.0.0.1:3939` 调用。

子计划：

1. 引入 Local API Token：
   - App 启动时生成高熵随机 token。
   - 所有敏感 API 必须校验 `Authorization: Bearer <token>`。
   - `/health` 可保持无鉴权。

2. 严格 CORS：
   - 移除 `Access-Control-Allow-Origin: *`。
   - Dev 只允许 `http://127.0.0.1:5174` 和 `http://localhost:5174`。
   - Production 不允许任意网页 origin。

3. 增加 Origin / Sec-Fetch-Site 校验。

4. Renderer 所有 fetch 统一经过 `renderer/api/local-client.ts`。

5. 中期迁移到 IPC：
   - 高风险工具调用优先走 Electron IPC。
   - HTTP 保留 debug/dev 用途。

验收目标：

- 无 token 调 `/api/tools/execute` 返回 401。
- 错误 token 返回 401。
- 非允许 Origin 返回 403。
- Renderer 内部调用正常。
- 不把 token 写入日志、transcript、tool activity 或 Realtime conversation。

### 板块 3：Electron 安全与桌面容器产品化

目标：

把 Electron 从 MVP 配置提升到产品安全基线。

当前应继续保留：

```ts
contextIsolation: true
nodeIntegration: false
sandbox: true
```

子计划：

1. 使用 custom protocol：
   - 生产使用 `her://app/index.html`。
   - 不长期依赖 `file://`。

2. 增加 CSP：
   - 限制 script、style、img、media、connect-src。
   - Dev 模式额外允许 Vite dev server。

3. 限制导航和新窗口：
   - 阻止非 Her URL 导航。
   - `shell.openExternal` 只允许安全 https URL。
   - 阻止 `javascript:`、`file:` 等协议。

4. 权限请求控制：
   - 麦克风只允许 Her 主窗口。
   - 禁止未知 frame 请求权限。

5. preload 安全桥：
   - 不暴露 `ipcRenderer`。
   - 只暴露最小 request API。

验收目标：

- Renderer 无 Node.js 权限。
- `window.require`、`process`、`Buffer` 不可用。
- 非 Her URL 导航被阻止。
- Dev 模式正常启动。
- `npm run build` 通过。

### 板块 4：统一工具 Manifest 与 Tool Runtime

目标：

消除工具定义重复。工具名称、Realtime schema、Zod schema、confirmation policy、renderer whitelist 不应多处维护。

子计划：

1. 新增 `defineTool`：

```ts
export type ToolRisk =
  | "read"
  | "local_open"
  | "local_write"
  | "external_send"
  | "browser_submit"
  | "system_change"
  | "shell"
  | "coding_agent";
```

2. 每个 domain 独立 manifest：
   - core
   - filesystem
   - documents
   - comms
   - media
   - desktop
   - browser
   - shell
   - coding

3. 自动生成 Realtime tool definitions。

4. 自动生成 / 推导 ToolName。

5. Renderer 不再手写 toolNames set。

验收目标：

- 新增工具只需要改一个 manifest。
- Realtime tools 由 manifest 自动生成。
- Zod validation 由 manifest 自动生成。
- Confirmation policy 读取 tool risk。
- unknown tool 被 runtime 拒绝。
- all tool names unique test 通过。

### 板块 5：Policy Engine 与 Approval Policy

目标：

把静态 `toolsRequiringConfirmation` 升级为产品级 Policy Engine。

Her 必须最终判断：

- capability 是否允许。
- App 是否授权。
- path 是否在 allowlist。
- 操作是否需要确认。
- YOLO 是否适用。
- 当前 risk 是否允许执行。

子计划：

1. 新增 `ApprovalPolicy`：

```ts
type ApprovalDecision =
  | { type: "allow"; audit: AuditRecord }
  | { type: "require_confirmation"; plan: ActionPlan }
  | { type: "deny"; reason: string; code: string };
```

2. 新增 `ActionPlan`，confirmation queue 保存 plan，不保存闭包。

3. ConfirmationQueue approve 后由 ToolRuntime 根据 plan 重新执行。

4. YOLO 限制：
   - 默认有 TTL。
   - 默认不绕过 shell / browser_submit / external_send / system_change / coding_agent。
   - dangerous YOLO 必须显式启用且有过期时间。

5. 审计日志增强：
   - args redaction
   - result status
   - durationMs
   - error code

验收目标：

- 只读工具不确认。
- 高风险工具确认。
- disabled capability 拒绝。
- unauthorized app 拒绝。
- allowlisted directories 继续生效。
- YOLO 有 TTL 和风险限制。
- confirmation UI 展示 action plan summary / risk / expiry。

### 板块 6：Realtime Session Runtime 与动态工具 Bundle

目标：

把 Realtime 连接/事件/工具逻辑独立成 runtime，实现 “core tools 常驻 + domain bundle 动态加载”。

子计划：

1. Server-mediated Realtime session：
   - Renderer 传 SDP 给 `/api/realtime/session`。
   - Her server 用标准 API key 请求 OpenAI Realtime。
   - Renderer 不直接知道 Realtime API URL。

2. `RealtimeSessionService`：
   - session config
   - instructions
   - core tools
   - bundle tools

3. 关闭自动 create_response：

```ts
turn_detection: {
  type: "server_vad",
  create_response: false,
  interrupt_response: true
}
```

4. Core tools 永远暴露：
   - `system_status`
   - `confirmation_list`
   - `confirmation_decide`
   - `app_permission_search`
   - `app_permission_set`
   - `capability_set`
   - `yolo_mode_set`
   - `her_select_bundle`

5. Domain bundles：
   - file
   - document
   - desktop
   - browser
   - comms
   - media
   - system
   - coding

6. Local bundle router：
   - deterministic rules MVP。
   - 低置信度使用 `her_select_bundle`。

验收目标：

- Realtime 仍能连接、说话、打断。
- 常见请求能选择正确 bundle。
- 不再默认全量暴露所有工具。
- 高风险工具仍经过 confirmation。
- 低置信度请求能 fallback 到 `her_select_bundle`。

### 板块 7：Codex 子代理运行时

目标：

把 Codex 作为 Her 的异步 coding agent，而不是普通 shell command。

正确架构：

```text
Realtime-2
↓
coding_agent_start
↓
Her CodingAgentRuntime
↓
Codex exec / SDK / app-server
↓
Task events + approvals + artifacts + patch
↓
Her UI
```

子计划：

1. 新增 coding-agent types：
   - task
   - event
   - artifact
   - approval

2. Codex MVP 使用 `codex exec --json`：
   - `spawn`，不要 `exec`。
   - 解析 JSONL stdout。
   - 支持 cancel / timeout / output limit。

3. Worktree 隔离：
   - 验证是 git repo。
   - 创建 `~/.her/agent-runs/<taskId>/repo`。
   - `git worktree add -b her/codex/<taskId> ...`。
   - Codex 在 worktree 内运行。

4. 环境变量隔离：
   - 不继承完整 `process.env`。
   - 不传 Her local API token。
   - 不传 Realtime secret。
   - 不传 OAuth/cookie/npm token。

5. Realtime tools：
   - `coding_agent_start`
   - `coding_agent_status`
   - `coding_agent_continue`
   - `coding_agent_cancel`
   - `coding_agent_get_result`

6. Renderer 新增 `AgentRunsPanel`。

验收目标：

- 可启动 coding task。
- 不阻塞 Realtime 语音。
- 可取消。
- 可显示事件和结果。
- Codex 不直接改原 repo。
- secrets 不泄露。
- `coding_agent_start` 默认 require confirmation。

### 板块 8：Renderer 产品 UI 改造

目标：

把 UI 从 MVP 控制台变成产品级桌面 Agent 控制台。

子计划：

1. 主界面：
   - Voice stage
   - transcript
   - permission panel
   - pending confirmations
   - tool activity
   - agent runs
   - authorized apps

2. 状态管理：
   - session-store
   - settings-store
   - confirmation-store
   - agent-task-store

3. Confirmation Panel 升级：
   - risk badge
   - summary
   - preview/diff
   - expiry
   - approve/reject
   - Codex approval decisions

4. Agent Runs Panel：
   - task status
   - latest event
   - command output
   - file changes
   - final summary
   - cancel

验收目标：

- 语音主流程可用。
- Confirmation UI 显示 risk 和 summary。
- Agent Runs panel 可显示 Codex task。
- 权限管理仍可用。
- YOLO 开启时有醒目警告。

### 板块 9：真实产品打包、签名、更新准备

目标：

继续使用 Electron + Vite，但加入产品分发基础设施。

子计划：

1. 引入 Electron Forge：
   - `forge.config.ts`
   - `package`
   - `make`
   - `publish`

2. Makers：
   - macOS zip + dmg
   - Windows squirrel 或 wix
   - Linux 可选

3. Code signing placeholders：
   - 不硬编码证书。
   - 使用 env 配置。

4. Notarization config：
   - macOS release build 预留。

5. Auto update skeleton：
   - stable / beta / canary channels。
   - update check placeholder。

6. App metadata：
   - app name
   - bundle id
   - icons
   - version
   - copyright

验收目标：

- `npm run package` 可以生成本地 app。
- `npm run make` 可以生成安装包或平台 artifact。
- 无 secret 硬编码。
- README 有打包说明。

### 板块 10：测试、质量门禁与回归

目标：

建立产品级基本测试体系。

子计划：

1. 引入 Vitest。
2. 新增 scripts：
   - `typecheck`
   - `test`
   - `test:watch`
   - `check`

3. Unit tests：
   - Path allowlist
   - CapabilityGate
   - ApprovalPolicy
   - Tool manifest uniqueness
   - Tool bundle router
   - Env sanitizer
   - Audit redaction
   - Local API auth middleware
   - Confirmation queue expiration
   - Codex JSONL parser

4. Integration tests：
   - `/api/tools/execute` without token → 401
   - invalid token → 401
   - disabled capability → denied
   - high risk tool → confirmation
   - approve confirmation → executes
   - reject confirmation → does not execute

5. Manual smoke checklist：
   - start app
   - connect voice
   - system_status
   - file_list Desktop
   - create folder confirmation
   - reject
   - approve
   - disable fileManagement
   - YOLO expiry
   - coding agent plan task

验收目标：

- `npm run check` 通过。
- 默认测试不需要 OpenAI key。
- 至少 30 个核心 unit/integration tests。
- manual smoke checklist 可执行。

### 板块 11：文档与开发者体验

目标：

让项目从“只有作者能理解”变成“Codex、未来协作者、未来自己都能理解”。

新增文档：

```text
docs/
  architecture.md
  security.md
  tool-runtime.md
  realtime-runtime.md
  coding-agent.md
  packaging.md
  manual-smoke-test.md
```

验收目标：

- README 链接所有 docs。
- 新增工具按 docs 操作可以成功。
- 新增 coding agent task 按 docs 可运行。
- 安全边界文档与代码一致。

## 5. 里程碑顺序

### Milestone 1：安全边界与最小结构拆分

范围：

- Local API token。
- CORS / Origin 校验。
- Renderer local-client。
- Server route/auth 最小拆分。
- 保持现有功能。

### Milestone 2：Tool Manifest + Policy Engine

范围：

- defineTool。
- manifest。
- 自动生成 Realtime tools。
- ApprovalPolicy。
- ActionPlan confirmation。

### Milestone 3：Realtime Runtime + Dynamic Bundles

范围：

- server-mediated session。
- create_response=false。
- bundle router。
- core tools + dynamic tools。
- her_select_bundle。

### Milestone 4：Codex Coding Agent MVP

范围：

- coding_agent tools。
- codex exec runner。
- worktree manager。
- env sanitizer。
- task store。
- Agent Runs panel。

### Milestone 5：Electron Packaging

范围：

- Electron Forge。
- package/make/publish scripts。
- macOS dmg/zip。
- signing/notarization placeholders。

### Milestone 6：Tests, docs, regression

范围：

- Vitest。
- API integration tests。
- policy/tool tests。
- docs。
- manual smoke test。

## 6. 每阶段必须运行

```bash
npm run build
```

若已添加测试脚本：

```bash
npm run typecheck
npm run test
npm run check
```

## 7. 不要做的事

- 不要一次性重写整个项目。
- 不要把 Realtime API key 放到 Renderer。
- 不要把 local API token 传给 Codex。
- 不要让 Codex 继承完整 `process.env`。
- 不要把 `Access-Control-Allow-Origin` 设为 `*`。
- 不要让外部网页调用 Her tools。
- 不要删除现有工具能力。
- 不要让 YOLO 默认绕过 shell / browser submit / external send / system change / coding agent。
- 不要把 tool schema 继续复制到多个文件。
- 不要把 Codex 作为普通 `advanced_shell_command` 长任务使用。
- 不要在日志记录完整邮件正文、文档正文、token、cookie、secret。

## 8. 建议新增配置

`.env.example` 可逐步补充：

```text
HER_SERVER_PORT=3939
HER_RENDERER_DEV_ORIGIN=http://127.0.0.1:5174
HER_ENABLE_HTTP_API=true
HER_ENABLE_IPC_API=true
HER_YOLO_DEFAULT_TTL_SECONDS=600
HER_CODEX_ENABLED=false
HER_CODEX_BIN=codex
HER_CODEX_AGENT_ROOT=~/.her/agent-runs
HER_CODEX_DEFAULT_SANDBOX=workspace-write
HER_CODEX_DEFAULT_APPROVAL=on-request
```

## 9. 最终产品形态验收

产品级 Her 应满足：

1. 用户可以自然语音启动任务。
2. Realtime-2 负责理解和选择工具，不负责绕过权限。
3. Her 根据当前语义动态暴露最小工具集。
4. 本地 API 不能被外部网页调用。
5. 所有高风险动作有清楚 confirmation。
6. 所有工具调用有 redacted audit log。
7. Codex 任务作为异步 agent task 运行，有 worktree 隔离和 UI 状态。
8. 应用能被打包成可分发桌面 app。
9. 测试覆盖 tool / policy / auth / bundle / codex 基础逻辑。
10. 文档能指导后续新增工具、新增 bundle、新增 agent。
