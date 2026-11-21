# 2026-11-20 飞书插件 CLI 单飞自动准备与首屏解锁

- 任务标识：`task-3e199feb-56b7-44c7-bb42-f49a8b392e55`
- 关联 Issue：[vilab-orulink/ViTalk#132](https://github.com/vilab-orulink/ViTalk/issues/132)（OPEN）
- 协同宿主任务：`vilab-orulink/ViTalk` `task-2517e0c7-3cc4-48b3-a4f8-f9f715335ade`（`documents/dev_log/2026-11-20/2026-11-20_121130_KID_未关联Issue_插件原生组件自动准备与首屏降级闭环/index.md`）
- 创建时间：2026-11-20 12:11:30 +08:00 (Asia/Shanghai)
- 建档作者：KID；参与者：用户、Antigravity
- 基线：`origin/main` `3242aa7736a163077639db42412475732df0f959`，分支 `codex/cli-auto-bootstrap`

## 背景与根因

在新环境或独立构建档（如内网测试版 `ai.orulink.vitalk.test`）中启用飞书插件（v0.1.8）但托管 `lark-cli` 尚未下载安装时：
1. `QuickMessagePage` 首屏调用 `experimentsRequest({ action: 'read' })` -> `workspaceSnapshot()` -> 直接调用 `native.execute` 执行 `lark-cli auth status`，未处理组件未安装状态；
2. 抛错后 `snapshot` 为 `undefined`，整个 `<Tabs>`（含「设置 → 飞书连接」面板中的 CLI 下载按钮）不渲染，右上角「连接飞书」（仅执行 `setTab('settings')`）失效，造成首屏空白死锁与误导性红字警告；
3. 语音指令触发时若遇到 `dependency_not_installed`，原先被归入“操作结果尚未确认，请先在飞书核对”分支。

## 关键变更

1. **新增单飞运行环境协调器 `src/cli-bootstrap.ts`**：
   - 合并首屏与设置页的 `native.status` / `native.install` 请求，状态变更派发 `feishu-cli-state-changed`，后台自动安装结束派发 `feishu-workspace-changed` 自动刷新工作台。
   - `recoverMissingCliFromRead` 同时兼容新宿主 `dependency_not_installed` 与旧宿主（v0.6.23）只读 `auth status` 返回 `native_outcome_unknown`（通过 `native.status` 二次核实 `installed === false` 后判定为组件未安装，不掩盖已安装 CLI 的真实运行失败）。
2. **工作台非阻塞降级与一键恢复（`src/client.ts`、`src/original-workspace/QuickMessagePage.tsx`、`FeishuConnectionSettings.tsx`）**：
   - CLI 未安装时 `workspaceSnapshot()` 返回带 `cliRuntime` 状态的空工作台快照并自动发起后台单飞下载，确保 `<Tabs>` 与「设置 → 飞书连接」始终可访问；
   - 首屏展示清晰的「正在准备飞书本地运行组件…」状态条，若网络异常失败则展示「飞书本地运行组件尚未就绪」引导卡与「重试安装组件」主按钮；
   - 点击「连接飞书」发起授权时若存在待完成或失败的组件安装，先自动完成 `lark-cli` 安装再进入扫码授权；
   - 对本地开发模式下大文件落盘期间偶发的 `temporarily_unavailable` 心跳核验状态，首屏被动读取与 `voice.ready` 握手最多以 850ms 间隔静默重试 3 次，消除临时红字闪现。
3. **语音指令前置缺失提示修正（`src/voice-workflow.ts`、`src/main.tsx`）**：
   - `dependency_not_installed` 明确报告为“飞书运行组件尚未安装或正在后台准备……本次请求未执行发送或创建”，并自动触发后台补装。

## TDD 与验证

- **Red**：新增 `src/client.test.ts`（新宿主 `dependency_not_installed` 与旧宿主 `native_outcome_unknown` 单飞自愈 2 项）、`QuickMessagePage.layout.test.tsx`（组件安装失败时 Tabs 可达与一键重试 1 项、开发心跳 `temporarily_unavailable` 静默重试 1 项）、`src/voice-failure.test.ts`（语音前置缺失提示 1 项），修改前均按预期失败。
- **Green**：实现后 `npm run typecheck` 通过，`npm test`（`build` + 51 个测试文件共 530 项 Vitest + 1 项 Node 原生包损坏校验）全部通过。

## Phase 3 补充修复（2026-11-20：发消息阻断根因、快捷键对齐 ViTalk 与全链路前置拦截）

### 根因排查
1. **发消息 100% 阻断（宿主操作账本编号冲突）**：`src/client.ts` 中 `selectedMessageContact` 直接将未包装的 `runtime.cli` 传入 `readMessageRecipient` 并复用单个 `contact-<uuid>`，当联系人详情缺少完整在职字段需要连续调用 `/open-apis/contact/v3/users/batch` 与两次 `+search-user` 时，宿主 `plugin_operations` 账本以 `CONFLICT`（`native_outcome_unknown`）拒绝第 2、3 次读取，`qualify` 抛出 `'无法核验联系人在职状态…'` 阻断发送。
2. **未缓存同事缺少通信录搜索兜底 & 前置失败误报“尚未确认”**：`message-workflow.ts` 在首轮匹配返回 `clarify` + `recipientQuery` 时未自动触发一次通信录搜索并重算；同时发送前校验失败与未连接错误未标记 `MessageNotSubmittedError` / `message_not_submitted`，导致语音浮窗隐藏真实原因并提示“操作结果尚未确认”，工作台将草稿锁死为 `unknown`。
3. **快捷键设置样式、交互及功能开关不一致**：`AgentVoiceShortcut.tsx` 使用旧版独立灰框 capturer、`keydown` 即提交且不捕获焦点与松开核对，`VoiceShortcutHint.tsx` 直接展示原始 `CommandOrControl+U`；`main.tsx` 未在语音入口校验 `feishuTools` 功能开关。

### 关键变更
- **消息发送与搜索闭环（`src/client.ts`、`src/person-context.ts`、`src/contact-service.ts`、`src/message-intent.ts`、`src/message-workflow.ts`、`src/workspace-message-service.ts`、`src/voice-message-confirmation.ts`、`src/original-workspace/FeishuMessagesWorkspace.tsx`）**：
  - `selectedMessageContact` 改用每次调用生成独立 `contact-<uuid>` 的包装器，消除多步身份核验与宿主账本冲突；
  - `workflow.prepare` 在 `awaitingRecipient && recipientQuery` 时通过 `searchRecipients` 自动搜索内部同事并合并去重候选后二次解析（搜索失败时降级保留人工选择列表）；
  - 新增 `MessageNotSubmittedError`（继承 `PreparationError`，`code = 'message_not_submitted'`）与 `confirm` 写 claim 前异常收敛 `markUnsent`，所有发送前校验/权限/对象不可用错误均保留真实可控文案且绝不锁死工作台草稿。
- **全链路前置失败与功能开关门控（`src/intent-model.ts`、`src/task-service.ts`、`src/task-workflow.ts`、`src/calendar-service.ts`、`src/calendar-workflow.ts`、`src/voice-operation-service.ts`、`src/voice-workflow.ts`、`src/main.tsx`、`src/original-workspace/QuickMessagePage.tsx`）**：
  - 将任务/日程/语音记录操作在 CLI 写请求前的所有参数、权限、账号切换、排班忙闲冲突与歧义拒绝统一收归 `PreparationError`（CLI 写之后的不确定失败保持原防重放行为不变）；
  - `voice-workflow.ts` 对 `CliNotAuthenticatedError` 与确认前 `message_not_submitted` 返回清晰未发送提示；
  - `main.tsx` 通过 `ensureVoiceEnabled` 在语言发送/创建/操作前核对 `config.feishuTools !== false`；`QuickMessagePage.tsx` 在快捷键保存刷新时保留进行中的 `liveReplies`。
- **快捷键录制与显示对齐 ViTalk（`src/lib/hotkeys.ts`、`src/original-workspace/VoiceShortcutHint.tsx`、`src/experiments/AgentVoiceShortcut.tsx`、`src/experiments/agent-voice-shortcut.css`）**：
  - 新增 `src/lib/hotkeys.ts` 对齐 ViTalk `formatHotkeyParts` / `formatHotkeyText` 与完整主键映射；`VoiceShortcutHint` 与设置行统一将 `CommandOrControl+...` 渲染为 `Ctrl+...` / `Cmd+...` 键帽；
  - 重构 `AgentVoiceShortcut` 复用 ViTalk `.settings-hotkey-compact` 单行内嵌录键交互（按住修饰键实时键帽预览、全键抬起提交、`Backspace/Delete` 或 `×` 清空、`Escape`/失焦/切窗自动恢复监听、160ms 不完整组合键提示且不退出监听、15 秒看门狗与恢复重试；保留点击聚焦同步与未禁用活跃触发按钮）。

### Phase 3 TDD 与验证
- **Red**：新增/更新 `src/client-message-send.test.ts`（复现宿主账本 `CONFLICT` 2 项）、`src/message-workflow.test.ts`（+2 项）、`src/voice-failure.test.ts`（+4 项）、`src/intent-model.test.ts`、`src/calendar-service.test.ts`、`src/task-workflow.test.ts`、`src/voice-operation-service.test.ts`、`src/lib/hotkeys.test.ts`（4 项）、`src/original-workspace/VoiceShortcutHint.test.tsx`（+1 项）及 `src/experiments/AgentVoiceShortcut.test.tsx`（13 项），各批修改前均观察到对应失败。
- **Green**：全仓执行 `npm run typecheck` 通过（0 错误），`npm test` 通过（`node build.mjs` 生成 `dist/vitalk-plugin-feishu.vitalk-plugin.json`，53 个测试文件共 545 项 Vitest + 1 项 Node 原生依赖校验全部通过），`git diff --check` 无异常；开发模式守护进程 `node dev.mjs` 同步构建最新快照成功（`sha256: a42b01a541b63c713708fe03da5c469418846745a0e2b849f8b633cd9cf8bd1e`）。

## Phase 4 延迟优化（2026-11-20：结构化传递已验证账号，消除冗余 `lark-cli auth status` 冷启动）

### 根因剖析
对单次语音发消息全链路计时定位，发现延迟主要来自 `lark-cli.exe auth status --json`（Windows 下每次冷启动约 335 ms）被重复串行拉起：
1. **弹窗前**（~7 次）：`ensureVoiceEnabled`、`readPreference`、`workflow.prepare` 前置校验、`readDraftCandidates`、`workflow.prepare` 模型后校验、`confirmMessage` 中 `readHistory()` 与 `read()` 各自触发独立认证检查；
2. **发送阶段**（~6 次）：`owned`、`selectedMessageContact` 中 `getWorkspaceState().read()` + 前/后 `runtime.readAccount()`、`workflow.confirm` 写入 `sending` 前校验、以及无附件纯文本发送仍在 `contentArgs` 后重复执行 `check()`；
3. **LLM 候选载荷冗余**：`draft-candidates.ts` 直接展开 `{ ...r }`，将 UI 字段 `avatarUrl` / `detail` 带入模型输入。

### 关键变更（无时间 TTL 缓存，保持账号切换即时拒绝）
- `src/workspace-state-service.ts`：对外暴露可选参数 `read(verifiedAccount?)` / `readHistory(verifiedAccount?)`，`saveCatalog` 复用首次校验到的账号对象从而收窄至两次边界校验。
- `src/message-workflow.ts`、`src/workspace-message-service.ts`、`src/client.ts`、`src/main.tsx`：
  - 将 `workflow.prepare` 单次认证结果 `verifiedAccount` 结构化透传给 `readPreference`、`readDraftRecipients`、`readRecipients`、`searchRecipients`、`readAllRecipients`、`requireVoiceEnabled` 检查及 `readVoiceMessageContext`（通过 `preparedDraftAccounts` 映射），将弹窗前 `auth status` 调用从 6–7 次压降至 **2 次**（模型前 1 次 + 模型后 1 次）；
  - `workflow.confirm` 将 `owned(id)` 验证后的账号透传给 `selectedMessageContact`（并仅在紧接写 claim 的单次路径跳过多余 `post` 读取），且在无图片附件的纯文本发送时省略 `contentArgs` 后的重复 `check()`，将文本发送阶段 `auth status` 调用从 6 次压降至 **2 次**（所有账号切换与写前校验边界保持不变）；
  - `workspace-create-service.ts` 同步支持 `requireVoiceEnabled` 与 `readPeople` 复用已认证账号；
  - `src/draft-candidates.ts` 仅投影 `id / name / kind / active / external / aliases / isContact` 最小字段，移除 `avatarUrl` 与 `detail`。

### Phase 4 TDD 与验证
- **Red**：在 `src/draft-candidates.test.ts`（+1 项）、`src/workspace-state-service.test.ts`（+1 项）、`src/client-message-send.test.ts`（+1 项：`prepare` + 上下文读取严格 2 次 `auth`，纯文本发送严格 2 次 `auth`，`feishuTools: false` 经 1 次 `auth` 与 0 次模型调用即抛出 `PreparationError`）写入测试，修改前 3 项均失败。
- **Green**：实现后执行 `npm run typecheck` 通过（0 错误），`npm test` 通过（`node build.mjs` 生成 `dist/vitalk-plugin-feishu.vitalk-plugin.json`，**53 个测试文件 548 项 Vitest + 1 项 Node 原生依赖校验全部通过**）；`node dev.mjs` 已生成最新开发快照（`sha256: d2341c507e189e1a56bd58f59bae8be94d8cc2fa8c00f25fba5c03f58e8a4803`）。

## 2026-11-21 实机复核与提交归档前检查
- **实机复核**：用户于 2026-11-20/21 在运行中的 ViTalk 本地开发窗口先后完成 `Alt+O` 快捷键录制、向同事发消息、弹窗直接按 `Enter` 提交与响应提速实机体验，明确授权执行 commit、创建 PR 并完成合入。
- **提交前核查**：复核 `codex/cli-auto-bootstrap` 相对 `origin/main`（`3242aa7736a163077639db42412475732df0f959`）全部待提交变更，确认不含 `.vitalk-dev/` 或凭据文件，`npm run typecheck`、`npm test`（53 个测试文件 548 项 Vitest + 1 项 Node 测试）与 `git diff --check` 全部通过。
