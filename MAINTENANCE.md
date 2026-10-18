# 维护原则

这个 fork = **上游 `Norman-else/dsh-claude`** + **我自己的功能**，跑在 **DSH Host** 上，驱动本机的
**Claude Code CLI**。四样东西各自会往前走，这份文档写清：每一条怎么跟、什么时候跟、跟错了会怎样。

```
① 自身（这个 fork）      master=稳定 / feature/latest=开发      → 版本 0.1.64-fork.N
② 上游 dsh-claude        upstream/master                        → 全量 merge，绝不 cherry-pick
③ DSH Host（App）        0.2.1-rc.2                              → 同步 78 个 devDep + override + 断言
④ Claude Code CLI        2.1.292（夹具停在 2.1.283）            → 抓 lineup 夹具 + 处理漂移
```

---

## 0. 一条铁律：同步上游一律「全量合并」，绝不 cherry-pick

```sh
git fetch upstream
git checkout feature/latest
git merge upstream/master          # ← 全量，把上游历史整条接进来
```

**为什么不能用 cherry-pick**：cherry-pick 只搬内容、不搬历史，于是

- `git merge-base` 退回很旧的提交 → 下次合并会把**早就跟进过的改动**再报一遍冲突；
- `git rev-list --count HEAD..upstream/master` 永远不是 0 → 看不出到底跟没跟上。

**本仓库踩过**：`0ea823f`（README 公告）和 `4d8d4d9`（#56 Bash-cd 修复）当初是 cherry-pick 进来的，
结果 HEAD 一直"落后上游 3 个提交"，直到 2026-10-18 做了一次全量 merge（`570571d`，**内容零差异**）
才把基点补回来。**内容相同不等于跟上了。**

跟完之后自查（两条都必须成立）：

```sh
git rev-list --count HEAD..upstream/master     # → 0
git merge-base HEAD upstream/master            # → 等于 upstream/master 的 tip
```

---

## 1. ① 自身：版本、分支、发布

| | |
|---|---|
| 版本号 | `0.1.65-fork.N` —— 自有序列，base 跟上游走（合并上游 0.1.65 后的第一次真实改动即 `0.1.65-fork.1`）。**纯文档改动不 bump** |
| `master` | 稳定线，默认分支。**只有它的 push / merge 触发构建与发布** |
| `feature/latest` | 开发线，不发布 |
| 发布 | `.github/workflows/release.yml`：`pnpm check` → `pnpm pack` → 重切 `v<version>` 滚动 tag |
| 给别人的 URL | `https://github.com/Castleeee/dsh-claude/releases/download/v<version>/norman-else-dsh-claude-<version>.tgz` |

日常：改动落 `feature/latest` → `pnpm check` → 验证后 `git checkout master && git merge --ff-only feature/latest && git push origin master` → 自动构建发布。

### 三种安装模式（本地）

```sh
node scripts/profile-mode.mjs link      # 开发：软链本 checkout，改完重建即可
node scripts/profile-mode.mjs dist      # 本地打包再装（贴近发布产物）
node scripts/profile-mode.mjs release   # 装线上 release（和别人的装法一致）
```

`DSH_PROFILE`（默认 `desktop`）和 `DSH_HOME`（默认 `~/.dsh`）可覆盖。**`link` 是唯一能边改边调的
模式**，但它有一条纪律：checkout 的 `@deepseek-ai/dsh-*` devDependencies 必须与 Host 同线（见 §2），
否则软链会把旧包塞进 Host 的解析路径 → 静默启动死锁。

---

## 2. ③ DSH Host：每次 App 升级都要跟

Host 不发类型声明，**只有把开发图钉到 Host 那条线，`pnpm typecheck` 才看得见真实 API**；不同步就
变成"编译期一套、运行期一套"，而 `link:` 会把编译期那套真的加载进运行时。

```sh
# 1) 读出 App 实际打包的版本
defaults read "/Applications/DeepSeek Harness.app/Contents/Info.plist" CFBundleShortVersionString
# 交叉验证某个包（也可用来发现"包已下线"）
node -e 'const b=require("fs").readFileSync("/Applications/DeepSeek Harness.app/Contents/Resources/app.asar");const s=b.toString("latin1");/* 搜 "name": "@deepseek-ai/dsh-agent" 附近的 "version" */'

# 2) 四处一起改成同一版本
#    package.json            78 个 @deepseek-ai/dsh-* devDependencies
#    package.json            22 个 peerDependencies 范围（>=<host-line>）
#    pnpm-workspace.yaml     overrides: '@deepseek-ai/dsh-*': <host-line>
#    test/package-contract   对 peer 范围、devDeps 集合、override、README Host 行的断言
#    另外：package.json 的 version 视改动性质决定是否 bump

# 3) ★ 把新版本加进 pnpm-workspace.yaml 的 minimumReleaseAgeExclude
#    新发布的包在 24 小时内会被 pnpm 的供应链策略拒绝：
#    ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION（2026-10-18 踩过，删掉这些 exclude 会直接装不上）

pnpm install
pnpm check
```

**App 升级后 `link:` 会立刻变得危险**，所以顺序永远是：先同步这一步，再切回 `link` 开发。

### 已记录的真实漂移（下次照查）

| 升级 | 抓到什么 | 怎么修的 |
|---|---|---|
| 0.1.7 → 0.2.x | `dsh-agent-presets`→`dsh-agent-preset-registry`；`SettingsForms.get()` 移除；`turnTail` 变普通 list slot；`Icon*Outline16`→`Icon*OutlineRegular/Medium` | 逐处改 |
| 0.2.1-rc.1 → rc.2 | `@deepseek-ai/dsh-invariants` 在 0.2.1 线**下线**（停在 0.2.0-rc.2） | 从 devDeps 删除（无代码引用） |
| 0.2.1-rc.1 → rc.2 | `JobKindMap` 只剩 `bash`，不再声明 `subagent` | 插件在自己的 `declare module` 里声明（kind 是不透明命名空间，插件是 job 生产者） |
| 0.2.1-rc.1 → rc.2 | Host 客户端包 `dsh-client-ui-conversation` 的 `require` 列表新增 `zod` | 测试的 `__ModuleLoader__` 垫片补一行 |

> 这类升级通常**只影响类型保真度**：0.2.1-rc.1→rc.2 之后 `lib/index.mjs` 与升级前逐字节相同。

---

## 3. ② 上游：合并流程与冲突速查

见 §0 的合并命令。冲突原则一句话：**自己功能涉及的 → 保留 ours；其余 → 取 theirs。**

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
| `README.md` / `INSTALL.md` | fork 的安装方式、两分支模型、维护文档 | 其余 |
| `package.json` | 我们的 `version`（`0.1.64-fork.N`）、`repository`/`homepage`/`bugs`（指向本 fork）、删除的 publish 脚本 | 上游其余字段 |
| `pnpm-workspace.yaml` | `overrides` 与 `minimumReleaseAgeExclude`（见 §2） | 其余 |

### 保留的自有功能（合并后自查）

| 功能 | 关键文件 |
|---|---|
| **World 系统**：Claude preset 有独立配置世界（独立默认模型 + 权限），切 preset 搬运 settings 文档 | `world-store.ts`、`world-switch.ts`、`world-wiring.ts`、`inbox-recovery.ts` |
| **文件级 rewind** | `file-rewind-routes.ts` |
| **CLI 回报的统计** + 上下文分类明细（关掉 Host 自己的统计行） | `ClaudeContextMeter.tsx`、`ClaudeStatsPills.tsx`、`claude-session-stats.ts` |
| **turn 改动文件面板** | `ClaudeTurnChanges.tsx` |
| **任务板 / 停止后台任务** | `task-routes.ts`、`task-api.ts`、`ClaudeTasksPanel.tsx` |
| **CLI 回复与鉴权** | `cli-reply.ts` |
| **实时 turn 状态 / activity fidelity** | `client/projection.ts`、`sidecar.ts`、`supervisor.ts` |
| **会话看板 + 会话提醒 + context usage 采集**（上游 0.1.64 删了，我们保留） | `ClaudePullRequestsPanel.tsx`、`repository-status-routes.ts`、`session-alerts.ts`、`events.ts` |
| **有意不跟**：`src/client/composer-style-probe.ts` 保持缺失 | `client/index.tsx` 有注释记录 |

### 直接取 theirs

`src/rewind.ts`、`src/steering.ts`、`src/adapter.ts`、`src/sdk-messages.ts`、`src/preset-route.ts`
中与 Host API 相关的部分，以及大部分 `test/**`。

---

## 4. ④ Claude Code CLI：夹具 + 漂移

| | |
|---|---|
| SDK 版本 | `@anthropic-ai/claude-agent-sdk`（当前 `0.3.247`）——按需 bump，跟 Host 无关 |
| 漂移机制 | `test/fixtures/claude-lineups/<CLI 版本>.json` 记录每个 CLI 版本广告的 `/model` 列表；`test/model-lineup-drift.test.ts` 要求**旧版本广告过的 id 在新版本里仍然可解析**（或能被 `canonicalClaudeModelId` 改写），否则 DSH 里已持久化的模型选择会变成悬空的 `claude/<id>` |
| 抓取 | `node --experimental-strip-types scripts/capture-model-lineup.mts [claude 路径]` |

**升级 CLI 后**：抓一份新夹具 → `pnpm test` → 若漂移测试失败，先判断是"CLI 真的淘汰了模型"
还是"插件没跟上"，需要时修 `src/model-catalog.ts`（别名/宽路由识别），再把夹具一起提交。

### 坑：别在代理后面抓夹具

本机 Claude Code 走本地代理（`~/.claude/settings.json` 里 `ANTHROPIC_BASE_URL=http://127.0.0.1:15721`
+ 自定义模型名），此时 CLI 报的是**代理的模型表**，不是 Claude Code 官方的 lineup。

2026-10-18 踩过：抓出来的 `2.1.292.json` 里全是 `deepseek-v4.1-flash[Opus]` 这种名字，漂移测试
立刻报 `fable[1m]` 悬空——**那是代理配置造成的假漂移**。这份夹具没有提交。

不过它顺带暴露了一个真 bug：代理把宽上下文路由拼成 `[1M]`（大写），而 `WIDE_ROUTE` 只认 `[1m]`，
于是宽路由被当成普通路由（少了 1M 窗口，且已持久化的 `fable[1m]` 不再解析）。**已修**为大小写不敏感，
并加了合成用例（`reads the wide route however the CLI spells it`）。

**规则**：夹具必须是**原版（默认配置）** CLI 的 lineup；在代理后面抓到的结果不要提交，只当作
"插件对某种拼写/形态是否健壮"的线索。

### 模型名是透传的；多 provider（ccswitch 之类）怎么算

**插件不改模型名。** 两层是分开的：

- DSH 侧持久化的是 selector id（插件按 CLI 广告的 row 派生的键，用于显示与记忆）；
- 真正发给 CLI 的是 **CLI 自己广告的那个 `value`**：`src/supervisor.ts` 里
  `model: claudeModelValue(model)`，而 `claudeModelValue(id) = claudeModelRow(id)?.value ?? id`。

所以 ccswitch / 代理怎么命名模型，插件就原样转发。lineup 的来源是**每次会话 initialize 时 CLI
自己报的 `/model` 列表**（`recordClaudeModels(initialization.models)`），启动时还会用
`probeClaudeModels` 先探一次。由此：

- **切换 provider 后，开一个新的 Claude 会话**（或重启 Host）就会刷新 lineup；开着老会话时，
  选择器里可能还残留上一个 provider 的模型行。
- 持久化的选择若不在当前 lineup 里，请求会**退回 `default`**，而不是把不属于当前 provider 的
  id 发出去（`preset-route` 的设计）。
- 同一个别名（`opus`、`fable`…）在不同 provider 下可以映射到不同模型，那是配置的事。
- 宽路由标记 `[1m]` / `[1M]` 两种拼写都已识别，**不需要为了插件统一大小写**（2026-10-18 修）。

---

## 5. 陷阱（踩过的，别再踩）

### 5.0 重建会把 `lib/` 清空——别让它撞上 App 启动

`tsdown` 构建**先清空输出目录**再写文件。`link:` 模式下 App 在启动时直接从 checkout 的 `lib/`
导入，所以如果 App 恰好在这个（几百毫秒~几秒的）窗口里启动，插件导入失败，**Host 会把它丢
掉并且不会重试**。

2026-10-18 踩过：一次被中断的构建留下空的 `lib/`，App 恰好此时重启 → 插件整个消失。

**判据**（两条任选）：

```sh
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:<port>/plugins/dsh-claude/doctor?token=<token>"   # 404 = 没挂载
```

或在 DevTools/调试端口里读 `window.__DSH_BOOT__.entries`，没有 dsh-claude 就是没加载。

**修法**：把 `lib/` 重新构建好，**重启 App**。实测重新 `pnpm add` 同一依赖**不能**让它重新挂载——
Host 只在启动时激活插件（所以任何 `src/*.ts` 改动都需要重启；`src/client/**` 才可能热载）。

### 5.1 `link:` 的两面

- **开发用**：`scripts/profile-mode.mjs link`，改完重建即可，是唯一的实时调试模式。
- **发布绝不用**：一旦 checkout 的 devDeps 与 Host 不同线（App 升级后必然如此），软链会把旧包塞进
  Host 的解析路径 → Host 判定公开插件不兼容 → **进程都在、端口在听、没有窗口、没有任何日志**。
- 判据：`ls ~/.dsh/profiles/<profile>/node_modules | grep -c deepseek` 必须是 `0`。

### 5.2 同一时间只能开一个 DSH App

官方 App、`DSH Desktop.app`、`DSH Desktop Beta.app` 共用 `~/.dsh`；同时跑会让两个 Host 驱动同一份
session 与插件状态，后两者端口还相同、会互相抢占。

### 5.3 pnpm 供应链策略（24h）

新发布的包在 24 小时内会被拒绝（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。跟 Host 新版本时
必须同步 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`——**它不是死配置**。

### 5.4 测试里一个环境相关的失败

`test/system-proxy.test.ts > adds the system proxy to a child that has none` 在本机会失败（shell 里有
小写 `http_proxy`/`https_proxy`，而 `hasProxyEnv` 大小写不敏感）。不是代码问题，跑之前清掉即可：

```sh
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY -u all_proxy pnpm check
```

### 5.5 启动死锁（历史，改动 activation 时当心）

**症状**：App 打不开：进程都在、host 在监听、**没有窗口、没有任何日志**，插件路由全 404。

**根因**：`agent-default-model` / `permission` 的写入发生在插件 activation 期间 →
`world-switch.recover()` → `settings.replace()` → `configEditor.edit()` → 等 profile `package.json`
的文件锁，而 boot 在挂载插件树期间一直持有那把锁 → 互相等待 → `apply()` 永不返回。
触发条件是 `$DSH_HOME/plugins/dsh-claude/worlds.json` 存在。

**修复**：`void recoverWorldAtBoot(...)` —— 去掉 `await`，让写入脱离 activation 路径。
**如果以后把任何 settings 写入挪回 activation 路径，就会再次死锁。**

排查手法：① 不要用 symlink 复制 `node_modules` 做隔离（假失败），用 `cp -R`；② 判据是启动日志里
有没有 `dsh web: http://127.0.0.1:...?token=...`（有=启动完成，没有=卡在 activation，端口照样监听，
只看端口会误判）；③ `inactiveEntries` 报 `failed to import` **不打印真正的 import 错误**。

---

## 6. profile 侧配置（与插件版本无关，别弄丢）

`~/.dsh/profiles/<profile>/cordis.patch.yml` 承载 0.2.0 起的设置（`~/.dsh/settings.yaml` 已迁移过去）：

- `llm-pi-ai` provider（`opencode-go`，`apiKeyEnv: OPENCODE_GO_API_KEY`）**及其 models 列表**
  （自动迁移只搬 provider，models 会丢）
- `permission.defaultPreset`
- `agent-default-model` 的 provider/model
- `ui-chat` / `ui-settings` / `ui-settings-account` 的界面设置

profile 的依赖声明形如：

```json
"@norman-else/dsh-claude": "file:/Users/jack/.dsh/artifacts/norman-else-dsh-claude-<version>.tgz"
```
