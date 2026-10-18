# 跟进上游的合并笔记

这个 fork 只有两件工作：

1. **跟进 `upstream/master`** —— 让分支始终以真实的上游历史为基点。
2. **保留下面第 2 节列出的自有功能** —— 合并时冲突一律先看这份清单。

- `origin` = `Castleeee/dsh-claude`（你的 fork）
- `upstream` = `Norman-else/dsh-claude`
- 分支模型（两条线，别再混）：
  - **`master`** = **稳定线**，也是默认分支。**只有 master 的 push / merge 触发构建与发布**，
    别人装的就是它切出来的 release。
  - **`feature/latest`** = **不稳定线**。新改动先落这里；验证好了再并进 master 才发布。

---

## 1. 怎么跟上游（每次照做）

```sh
cd /Users/jack/code/dsh-plugins/dsh-claude
git fetch upstream
git checkout feature/latest
git merge upstream/master

# 冲突处理：自己功能涉及的 → 保留 ours；其余 → 取 theirs（第 3 节有速查表）

pnpm install --frozen-lockfile
pnpm check                                   # typecheck + test + build

# 验证通过后才进稳定线 —— master 的 push 会触发构建并重切 release
git checkout master
git merge --ff-only feature/latest
git push origin master
```

`git merge-base feature/latest upstream/master` 应当等于上游的某个 tip：
基点干净，git 只会对**两边都改过**的行报冲突。

版本号用 `0.1.64-fork.N` 这样的自有序列，不要跟上游的 `0.1.6x` 混淆。

**发布是自动的**：`master` 的每次 push / merge 都会跑 `.github/workflows/release.yml`
（`pnpm check` → `pnpm pack` → 重切 `v<version>` 滚动 tag），所以给别人的那一条 URL

```
https://github.com/Castleeee/dsh-claude/releases/download/v<version>/norman-else-dsh-claude-<version>.tgz
```

**只在你 bump 版本号时才变**。纯文档改动不要 bump：同一个 tag 会被重切，URL 不变。

**上游已有等价或更好实现的，一律取上游、不要重做**：URL-userinfo 脱敏边界、进度遥测离开
durable 路径、未知消息只报一次、prompt size 取 `message_delta`、cost 按进程记账、turn outcome
带 exit code/signal/stderr、非图片附件传路径、thinking 4000 字符上限、mid-turn steering 送达、
effort 走 control request 不重生进程、问答行记录所选答案、code block 用 Host 的 CSS 变量。

---

## 2. 必须保留的自有功能

### 2.1 上游完全没有的

| 功能 | 关键文件 |
|---|---|
| **World 系统**：Claude preset 拥有独立配置世界（独立默认模型 + 权限），切 preset 搬运 settings 文档而非覆盖 | `src/world-store.ts`、`src/world-switch.ts`、`src/world-wiring.ts`、`src/inbox-recovery.ts` |
| **文件级 rewind**：直通 Claude Code 的 `rewindFiles()` | `src/file-rewind-routes.ts` |
| **CLI 回报的统计**：关掉 Host 自己的 composer 统计行，改画 CLI 报的账；上下文表带分类明细（system prompt / tools / messages 各占多少 + 配色） | `src/client/ClaudeContextMeter.tsx`、`src/client/ClaudeStatsPills.tsx`、`src/client/claude-session-stats.ts` |
| **turn 改动文件面板** | `src/client/ClaudeTurnChanges.tsx` |
| **任务板 / 停止后台任务** | `src/task-routes.ts`、`src/client/task-api.ts`、`src/client/ClaudeTasksPanel.tsx` |
| **CLI 回复与鉴权** | `src/cli-reply.ts` |

### 2.2 上游没合并的（上游另有方案）

| 功能 | 关键文件 |
|---|---|
| 运行中 turn 的实时状态、activity fidelity | `src/client/projection.ts`、`src/sidecar.ts`、`src/supervisor.ts`、`ClaudeLiveProgress` |
| 任务板停止后台任务 | `src/task-routes.ts`（上游走 Host job list 另一条路） |

### 2.3 上游删掉、我们有意保留

上游 0.1.64 删掉了会话看板、会话提醒和 context usage 采集，**三样都保留**：

| 保留的东西 | 关键文件 | 为什么 |
|---|---|---|
| **会话看板**（右栏 overview tab） | `src/client/ClaudePullRequestsPanel.tsx`、`src/repository-status-routes.ts` | 一屏看所有 Claude 会话的分支/PR/上下文/是否在等你 |
| **会话提醒**（桌面通知） | `src/client/session-alerts.ts` | 切到别的会话时，有会话在等你批准/回答会通知 |
| **context usage 采集管道** | `src/events.ts`（`ClaudeContextUsage*`、`normalizeContextUsage`、`latestClaudeContextUsage`）、`src/sidecar.ts`（`contextUsage`）、`src/client/projection.ts`、`src/constants.ts`、`src/supervisor.ts`（`contextUsage()`） | 2.1 的上下文分类表依赖它；上游改用 DSH 原生表，但原生表没有分类明细 |

### 2.4 有意不跟上游的

- `src/client/composer-style-probe.ts`：**保持缺失**。这个探针监听的是「插件自己的仓库栏」，而我们的版本不再注册那个栏 → 探针永远找不到元素，会在页面生命周期内一直挂着 MutationObserver 且永不报告。`src/client/index.tsx` 有注释记录这个决定。
- 上游删三块功能那一次（见 2.3）：**不跟**。

---

## 3. 冲突处理速查表

一句话：**自己功能涉及的 → 保留 ours；其余 → 取 theirs。**

### 冲突时保留 ours

```
src/world-store.ts              src/world-switch.ts        src/world-wiring.ts
src/inbox-recovery.ts           src/file-rewind-routes.ts  src/cli-reply.ts
src/task-routes.ts              src/client/task-api.ts
src/client/ClaudeTasksPanel.tsx    src/client/ClaudeTurnChanges.tsx
src/client/ClaudeContextMeter.tsx  src/client/ClaudeStatsPills.tsx
src/client/claude-session-stats.ts src/client/session-mark.ts
src/client/ClaudePullRequestsPanel.tsx   src/client/session-alerts.ts
src/repository-status-routes.ts
```

### 需要逐块混合的

| 文件 | 必须保留我们的 | 其余取上游 |
|---|---|---|
| `src/events.ts` | `ClaudeContextUsage*`、`normalizeContextUsage`、`latestClaudeContextUsage`、`ClaudeLiveProgress` | 其余 |
| `src/sidecar.ts` | `contextUsage` 字段 / 校验 / 持久化 | 其余 |
| `src/client/projection.ts` | `contextUsage` state + delta | 其余 |
| `src/constants.ts` | `CLAUDE_CONTEXT_USAGE_EVENT`、`CLAUDE_REPOSITORY_STATUS_PATH`、alert 常量、`CLAUDE_FILE_REWIND_PATH`、`CLAUDE_TASK_STOP_PATH` | 其余 |
| `src/supervisor.ts` | `contextUsage()`、文件 rewind、per-task stop | 其余 |
| `src/index.ts` | world / task / file-rewind 路由注册、context meter 与 stats 的 slot 注册 | 其余 |
| `src/client/index.tsx` | 上述 slot 注册、overview/tasks tab、`ClaudeStatsPills` 占 `conversation.composer.dock` | 上游的 slot 与 import |
| `src/client/sidebar-tabs.tsx` | `tasks` + `overview` 两个 tab kind 及其 panel | 其余 |
| `src/client/styles.ts` | 我们保留功能的样式 | 上游样式改动 |
| `src/client/locales.ts` | 我们保留功能的文案 key | 上游新增 key |
| `src/global-settings.ts` | 会话提醒的 Settings 开关 | 其余 |
| `src/client/ClaudeCodeSettings.tsx` | 提醒相关字段（`alertModeOf` 等） | 其余 |
| `README.md` / `INSTALL.md` | 描述 fork 安装方式与保留功能的小节 | 其余 |

### 直接取 theirs

`src/rewind.ts`、`src/steering.ts`、`src/adapter.ts`、`src/sdk-messages.ts`、
`src/preset-route.ts` 中与 Host API 相关的部分，以及大部分 `test/**`。

---

## 4. 陷阱（踩过的，别再踩）

### 4.1 不要把 fork `link:` 进 profile

**症状**：官方 App 启动时静默卡住（窗口不出现、无报错、CPU 0%），或 CLI 启动报
`startup failed: 1 required plugin did not activate`。

**原因（2026-10-18 更新）**：开发图以前固定是 `0.1.7-rc.2` 而 Host 已经 0.2.x，所以
`link:` **必然**踩雷。现在开发图已与 Host 同线（`0.2.1-rc.2`），link 当下能跑——**但没有
保障**：App 一升级，checkout 里的 devDependencies 就落后，同一个故障会用完全相同的方式
静默回来（Node 从 fork 的真实路径解析 import，旧包遮蔽 Host 自己的，所有公开插件被判不兼容）。

**正确做法**：`pnpm pack` 打成 tgz 再 `dsh plugin add`。devDependencies 不会进 tgz，
运行时自然解析到 Host 自己那套。装完确认：

```sh
ls ~/.dsh/profiles/desktop/node_modules | grep -c deepseek   # 必须输出 0
```

### 4.2 同一时间只能开一个 DSH App

官方 App、`DSH Desktop.app`、`DSH Desktop Beta.app` 共用 `~/.dsh`；同时跑会让两个 Host
驱动同一份 session 与插件状态，且后两者端口相同会互相抢占。

### 4.3 Host API 漂移（每次 App 升级都要跟一遍）

**开发图现在与 Host 同步**：`package.json` 的 78 个 `@deepseek-ai/dsh-*` devDependencies、
`pnpm-workspace.yaml` 的 override、以及 `test/package-contract.test.ts` 的断言，全部钉在
Host 当前那条线（`0.2.1-rc.2`）。Host 不发类型声明，所以**只有这一步能让 `pnpm typecheck`
看见真实的 Host API**；不同步就又会变成「编译期一套、运行期一套」。

跟法：先从 App 读出它实际打包的版本——`defaults read "/Applications/DeepSeek Harness.app/Contents/Info.plist" CFBundleShortVersionString`，
或直接从 `app.asar` 里抽查 `"name": "@deepseek-ai/dsh-xxx"` 附近的 `"version"`——再把
package.json / pnpm-workspace.yaml / 本文件 / 该测试一起改成同一版本，然后 `pnpm install && pnpm check`。

**0.1.7 → 0.2.x 那次迁移撞过的**：

| 旧 | 新 |
|---|---|
| `@deepseek-ai/dsh-agent-presets` | `@deepseek-ai/dsh-agent-preset-registry` |
| `SettingsForms.get()` | 已移除，用 `describe()` |
| `conversation.chat.turnTail` 带 `select` | 普通 list slot，`inject` 只给 `{ t }` |
| `Icon*Outline16` | `Icon*OutlineRegular` / `Icon*OutlineMedium` |

**0.2.1-rc.2 这次抓到的（已修，下次照查）**：

- `@deepseek-ai/dsh-invariants` 在 0.2.1 线**已下线**（最后版本 `0.2.0-rc.2`）→ 从 devDeps 删除。
- `JobKindMap` 只剩 `bash`：Host 不再声明 `subagent`。`src/host-jobs.ts` 改为在插件自己的
  `declare module` 里声明它（kind 是不透明 id 命名空间，插件是这些 job 的生产者）。
- Host 客户端包 `dsh-client-ui-conversation` 的 `require` 列表新增 `zod`；
  `test/client-sidecar-conversation.test.ts` 的 `__ModuleLoader__` 垫片要跟着补，
  否则报 `Cannot read properties of undefined (reading 'z')`。
- 升级后 `lib/index.mjs` 与升级前**逐字节相同**（只变了 `index.d.mts` 与 source map）——
  说明这类升级只影响类型保真度，不影响运行时。

### 4.4 测试里有一个环境相关的失败

`test/system-proxy.test.ts > adds the system proxy to a child that has none` 在本机会失败，
因为 shell 里有小写 `http_proxy` / `https_proxy`，而 `hasProxyEnv` 大小写不敏感。不是代码问题：

```sh
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
    -u ALL_PROXY -u all_proxy npx vitest run test/system-proxy.test.ts
# → 6 passed
```

---

## 5. profile 侧的配置（与插件版本无关，别弄丢）

`~/.dsh/profiles/desktop/cordis.patch.yml` 承载 0.2.0 的设置（0.2.0 起 `~/.dsh/settings.yaml`
的配置迁到了 profile 的 patch 文件），其中有：

- `llm-pi-ai` provider（`opencode-go`，`apiKeyEnv: OPENCODE_GO_API_KEY`）**及其 models 列表**
  （0.2.0 的自动迁移只搬了 provider，models 会丢，需要手工补回）
- `ui-chat` / `ui-settings` / `ui-settings-account` 的界面设置

profile 的依赖声明形如：

```json
"dependencies": {
  "@norman-else/dsh-claude": "file:/Users/jack/.dsh/artifacts/norman-else-dsh-claude-<version>.tgz"
}
```

> ⚠️ `dshmarket` 曾需锁在具体版本而不跟随 `^`：官方 App 的 pnpm 有 `minimumReleaseAge`
> 供应链策略，太新的版本会被拒（`PM_MINIMUM_RELEASE_AGE_VIOLATION`）。

---

## 6. 已修复的启动死锁 —— 改这里要当心

**症状**：官方 App 打不开：进程都在、host 也在监听、但**没有窗口**、**没有任何日志**
（`~/Library/Logs/DeepSeek Harness/` 干净），插件路由全部 404，而 base 路由是 401。

**根因**：`agent-default-model` / `permission` 的写入发生在插件 activation 期间会死锁。

```
src/index.ts  →  await recoverWorldAtBoot(worldSwitch, warn)   ← activation 期间
world-switch.ts recover()  →  await settings.replace(ns, section)
dsh-settings write() → configEditor.edit()
dsh-config-editor edit() → await withFileLock(<profile>/package.json, ...)  ← 这里
```

boot 在挂载整棵插件树期间一直持有 profile `package.json` 的文件锁，插件在自己 activation 里
再去要这把锁 → 互相等待 → `apply()` 永不返回 → Host 永不发 `ready` → 没有窗口也没有报错。
触发条件是 `$DSH_HOME/plugins/dsh-claude/worlds.json` 存在。

**修复**：去掉 `await`，让恢复写入脱离 activation 路径。

```ts
// 不要写回 await！
void recoverWorldAtBoot(worldSwitch, message => { ctx.logger.warn(message) })
```

`withFileLock` 会等锁而不是失败，所以 activation 结束后锁释放，写入随后成功。
**如果以后把任何 settings 写入挪进 activation 路径，就会再次死锁。**

### 排查这类问题的正确手法

1. **不要用 symlink 复制 node_modules 做隔离测试** —— 会得到假失败。用 `cp -R` 真拷贝。
2. **把真实 profile 拷到隔离 home 会掩盖问题**（少了 `~/.dsh` 的状态）。要判断是 profile
   还是 home 的问题，得把可用 profile 放进真实 home 反向验证。
3. 判据：启动日志里有没有 `dsh web: http://127.0.0.1:...?token=...`。**有 = 启动完成；
   没有 = 卡在 activation**（端口照样监听，只看端口会误判）。
4. `inactiveEntries` 报 `failed to import` 只表示 `fiber === undefined`，**不打印真正的
   import 错误**，别指望从那里拿到原因。
