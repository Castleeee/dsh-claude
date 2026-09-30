# 跟随上游的合并笔记（给下次做 merge 的 AI 看）

本文件说明：这个 fork 相对上游 `Norman-else/dsh-claude` 到底改了什么、为什么、
以及下次 `git merge upstream/master` 时哪些文件必须「保留我们的」、哪些必须「取上游的」。

- `origin` = `Castleeee/dsh-claude`
- `upstream` = `Norman-else/dsh-claude`

---

## 0. 一句话现状

当前主干是 `port/upstream-tracked`，它是一个**真正的 2-parent 合并提交**：

```
1490d87  Merge remote-tracking branch 'upstream/master' into ...
  parent 1: efae7e6  Your fork's content, on its true upstream base
  parent 2: cd1c57f  (upstream/master 当时的 tip)
```

含义：**上游的一切都在历史里**（parent 2），我们只在上面叠了自己的东西。
相对上游的差异总量：`76 files changed, +9618 / -326`。

---

## 1. 下次怎么跟上游（照这个做）

```sh
cd /Users/jack/code/dsh-plugins/dsh-claude
git fetch upstream

# 关键：以 port/upstream-tracked 为工作分支，不要用旧的 merge/upstream-0.1.63
git checkout port/upstream-tracked
git merge upstream/master

# 冲突处理原则见下面第 3、4 节：自己的功能「保留我们的」，其余「取上游的」

pnpm install
pnpm run typecheck && pnpm test && pnpm run build

# 打包安装（不要用 link:，原因见第 6 节）
pnpm pack --pack-destination ~/.dsh/artifacts
cd ~/.dsh/profiles/desktop
pnpm add ~/.dsh/artifacts/norman-else-dsh-claude-<version>.tgz
# 然后重启官方 DeepSeek Harness
```

**为什么基点现在是干净的**：`git merge-base port/upstream-tracked upstream/master` ==
`upstream/master` 当时的 tip。下次上游发新版时，git 只会对我们**真正改过、上游也改过**的行报冲突。

**一个额外好处**：上游删掉、我们保留的文件，**下次不会再冲突**。因为基点里它们已经是
「上游已删除」的状态，上游那边没有新改动，git 会静默保留我们的版本。

---

## 2. 你的 PR 已经进了上游 —— 不要再重做

以下 11 个提交已确认是 `upstream/master` 的祖先。**这些实现可以丢弃，以上游的为准**
（上游还顺手修了 4 个 bug，见 4.3）。

| 你的 PR | 上游提交 | 业务内容 |
|---|---|---|
| #39 | `3731ae7` | 给 URL-userinfo 脱敏正则加边界，避免二次扫描退化成平方复杂度 |
| #40 | `6107bae` | 进度遥测不再写 durable 路径（`thinking_tokens` 不再每帧一行） |
| #41 | `95d7b9d` | 未知消息类型只报一次，并保留流计数 |
| #42 | `f304afd` | 用 `message_delta` 取真实 prompt size（修上下文表恒 0%） |
| #43 | `c305fcb` | 进程重生后 cost/usage 不倒退 |
| #44 | `3d56df6` | 死掉的 turn 记录 exit code / signal / stderr |
| #45 | `93e97db` | 非图片附件把路径交给 Claude，而不是丢掉 |
| #47 | `8a3fa3c` | thinking 4000 字符上限 + 忙碌会话不再刷警告 |
| #49 | `dd515d8` | 中途 steering 真正送达运行中的 turn |
| #53 | `1c99367` | effort 切换走 control request，不重生进程 |
| #54 | `7121c3c` | 问答行记录「选了哪个答案」 |

**#46 code block 配色**：上游用自己的方案实现（`54a790f` / `8456184` / `b0e0c67`），
结论是**采纳上游**——它用 `var(--dsw-alias-markdown-code-block)` 跟随 Host 主题，
而我们的版本硬编码 hex、且没限定深色主题（浅色下会出现近黑色块）。
对应的 `fix/codeblock-surface-colors` (`4a91d45`) 可以丢弃。

---

## 3. 必须保留的（我们的功能）

### 3.1 完全独创、上游没有任何对应实现

| 功能 | 关键文件 | 起始提交 |
|---|---|---|
| **World 系统** —— 让 Claude preset 拥有独立配置世界（独立默认模型 + 权限），切 preset 时搬运 settings 文档而非覆盖 | `src/world-store.ts`、`src/world-switch.ts`、`src/world-wiring.ts`、`src/inbox-recovery.ts` | `99abe67` Give the Claude preset its own settings world |
| **文件级 rewind** —— 直通 Claude Code 的 `rewindFiles()`，不做重建 | `src/file-rewind-routes.ts` | `88066c4` Carry a Claude turn's file rewind over one Host route |
| **CLI 回报的统计** —— 关掉 Host 自己的 composer 统计行，改画 CLI 报的账；上下文表带**分类明细**（system prompt / tools / messages 各占多少 token + 配色） | `src/client/ClaudeContextMeter.tsx`、`src/client/ClaudeStatsPills.tsx`、`src/client/claude-session-stats.ts` | `4f90374`、`4253ff6` |
| **turn 改动文件面板** | `src/client/ClaudeTurnChanges.tsx` | `11652a8` |
| **任务板 / 停止后台任务** | `src/task-routes.ts`、`src/client/task-api.ts`、`src/client/ClaudeTasksPanel.tsx` | `cb3c0b7` Let the task board end a background task |
| **CLI 回复与鉴权** | `src/cli-reply.ts` | `c3bcc48` |

### 3.2 上游没合并的 PR（上游有别的方案，我们保留自己的）

| 功能 | 关键文件 | 起始提交 | 上游情况 |
|---|---|---|---|
| 运行中 turn 的实时状态（PR #48） | `src/client/projection.ts`、`src/sidecar.ts`、`src/supervisor.ts`、`ClaudeLiveProgress` 类型 | `9b5b5c3` | 无对等实现 |
| activity fidelity（PR #50） | 同上 | `b6812fb` | 只抄了基础部分 |
| 任务板停止（PR #52） | `src/task-routes.ts` | `cb3c0b7` | 走了 Host job list 另一条路 |

### 3.3 上游删掉了、但我们有意保留

上游在 `7d57fda`（0.1.64）删掉了会话看板、会话提醒、以及 context usage 采集。
**我们三样都保留**，理由分别是：

| 保留的东西 | 关键文件 | 为什么保留 |
|---|---|---|
| **会话看板**（右栏 overview tab） | `src/client/ClaudePullRequestsPanel.tsx`、`src/repository-status-routes.ts` | 一屏看所有 Claude 会话的分支/PR/上下文/是否在等你 |
| **会话提醒**（桌面通知） | `src/client/session-alerts.ts` | 切到别的会话时，有会话等你批准/回答会通知 |
| **context usage 采集管道** | `src/events.ts`（`ClaudeContextUsage*`、`normalizeContextUsage`、`latestClaudeContextUsage`）、`src/sidecar.ts`（`contextUsage` 字段与持久化）、`src/client/projection.ts`（state + delta）、`src/constants.ts`（`CLAUDE_CONTEXT_USAGE_EVENT`、`CLAUDE_REPOSITORY_STATUS_PATH`、alert 系列常量）、`src/supervisor.ts`（`contextUsage()` 元数据方法） | **3.1 的上下文表依赖它**。上游删它是因为改用 DSH 原生表，但原生表没有分类明细 |

> 冲突时这些一律 **保留我们的（ours）**。

---

## 4. 我们主动采纳了上游的（取舍记录）

### 4.1 这次合并从上游拿进来的

| 上游提交 | 业务内容 | 备注 |
|---|---|---|
| `cd1c57f` | Claude 正文里的行内代码路径变成可点击链接 → 侧边栏预览 | 本次主要收益 |
| `80fc905` | 让 Claude 主动把文件提及写成 Markdown 链接 | |
| `13573f6` | 仓库栏 / 评审评论栏样式跟随 Host dock 面板 | |
| `8522b69` | Windows 下从结构化 tool result 找后台任务输出路径 | 对 macOS 无影响 |
| `af97440` / `205dcae` | rewind 时隐藏被回退 turn 的进程行 / 进程组座位 | |

### 4.2 我们有意不跟上游的

| 上游改动 | 我们的决定 | 原因 |
|---|---|---|
| `7d57fda` 删除三块功能 | **不跟**（见 3.3） | 我们要用 |
| `src/client/composer-style-probe.ts` | **保持缺失** | 这个探针监听的是「插件自己的仓库栏」，而我们的版本不再注册那个栏 → 探针永远找不到元素，会在页面生命周期内一直挂着 MutationObserver 且永不报告。`src/client/index.tsx` 134-139 行有注释记录这个决定 |
| `b16eac9` 版本号 0.1.64 | 用我们自己的版本号 `0.1.64-fork.N` | 避免和上游版本混淆 |

### 4.3 顺带拿到的上游加固（比我们的实现好）

上游在移植时做了 review，这 4 处**上游更优**，冲突时取上游：

1. **#43 cost**：上游按进程记账（`costReading`）+ 从 sidecar 读回，我们靠「计数下降」推断
   → 新进程首轮花费超过上一进程全程时会算错；Host 重启后会归零。
2. **#44 turn-outcome**：上游加了 `redactText()` 脱敏，且把 stderr 读取移到 bounded wait **之后**
   （崩溃的 CLI 常在退出路上才写下最后的话）。
3. **#53 effort**：上游多一个 `model === entry.model` 短路，省一次注定白费的 RPC。
4. **#46 codeblock**：上游用 Host 的 CSS 变量，且修了浅色主题污染。

---

## 5. 冲突处理速查表

**一句话原则：自己功能涉及的 → 保留 ours；其余 → 取 theirs。**

### 保留 ours 的文件（冲突时）

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

### 需要「混合」的文件（两边都改过，逐块看）

| 文件 | 我们的部分必须保留 | 上游的部分要拿 |
|---|---|---|
| `src/events.ts` | `ClaudeContextUsage*`、`normalizeContextUsage`、`latestClaudeContextUsage`、`ClaudeLiveProgress` | 其余 |
| `src/sidecar.ts` | `contextUsage` 字段 / 校验 / 持久化 | 其余 |
| `src/client/projection.ts` | `contextUsage` state + delta | 其余 |
| `src/constants.ts` | `CLAUDE_CONTEXT_USAGE_EVENT`、`CLAUDE_REPOSITORY_STATUS_PATH`、alert 常量、`CLAUDE_FILE_REWIND_PATH`、`CLAUDE_TASK_STOP_PATH` | 其余 |
| `src/supervisor.ts` | `contextUsage()` 元数据方法、文件 rewind、per-task stop | 其余（含 #43/#44/#53 的上游实现） |
| `src/index.ts` | world / task / file-rewind 路由注册、context meter 与 stats 的 slot 注册 | 其余 |
| `src/client/index.tsx` | 上述所有 slot 注册、overview/tasks tab 的 face、`ClaudeStatsPills` 占 `conversation.composer.dock` | 上游的 slot 与 import |
| `src/client/sidebar-tabs.tsx` | `tasks` + `overview` 两个 tab kind 及其 panel | 其余 |
| `src/client/styles.ts` | 我们保留功能的样式（overview / alert / queue / task 等） | 上游的样式改动 |
| `src/client/locales.ts` | 我们保留功能的文案 key | 上游新增 key |
| `src/global-settings.ts` | 会话提醒的 Settings 开关 | 其余 |
| `src/client/ClaudeCodeSettings.tsx` | 提醒相关字段（`alertModeOf` 等） | 其余 |
| `README.md` / `docs/**` | 描述我们保留功能的小节 | 其余 |

### 直接取 theirs 的

`legacy-preset/`、`src/preset-installer.ts`、`src/rewind.ts`、`src/steering.ts`、
`src/adapter.ts`、`src/sdk-messages.ts`、`src/preset-route.ts` 中与 0.2.0 API 相关的部分，
以及所有 `test/**` 中与「被上游删除的功能」无关的用例。

---

## 6. 陷阱（踩过的坑，别再踩）

### 6.1 千万不要把 fork `link:` 进 profile

**症状**：官方 App 启动时静默卡住（窗口不出现、无报错、CPU 0%），
或 CLI 启动报 `startup failed: 1 required plugin did not activate`。

**原因**：fork 自己的 `node_modules/@deepseek-ai/*` 是 **0.1.7-rc.2**（devDependencies，
为了本地 typecheck）。`link:` 之后 Node 从 fork 的真实路径解析它的 import，于是这套
0.1.7 遮蔽了 Host 的 **0.2.0-rc.2** → 37 个插件被判不兼容 → 启动失败。

**正确做法**：`pnpm pack` 打成 tgz 再 `pnpm add` 进 profile。
devDependencies 不会进 tgz，运行时自然解析到 Host 的 0.2.0。
装完确认：`ls ~/.dsh/profiles/desktop/node_modules | grep deepseek` 必须是 **0**。

### 6.2 历史曾经是 squash 的（已修复，但别再犯）

旧的 `merge/upstream-0.1.63` (`1d6bb2e`) **只有一个 parent**，上游历史被压平 →
git 的合并基点退回很旧的提交 → 全量 merge 会产生 **37 文件 / 118 处假冲突**。
`port/upstream-tracked` 已经修好这个问题（冲突降到 8 文件 / 15 处）。
**以后一律在 `port/upstream-tracked` 上工作。**

### 6.3 同一时间只能开一个 DSH App

`DeepSeek Harness.app`（官方，端口 19387）、`DSH Desktop.app`（端口 43120）、
`DSH Desktop Beta.app`（端口 43120）共用 `~/.dsh`。同时跑会让两个 Host 驱动同一份
session 与插件状态。另外 `DSH Desktop.app` 和 Beta **端口相同，会互相抢占**。

### 6.4 Host 0.2.0 的 API 变更（合并时容易撞）

| 0.1.x | 0.2.0 |
|---|---|
| `@deepseek-ai/dsh-agent-presets` | `@deepseek-ai/dsh-agent-preset-registry` |
| `SettingsForms.get()` | 已移除，用 `describe()` |
| `conversation.chat.turnTail` 带 `select` | 普通 list slot，`inject` 只给 `{ t }` |
| `Icon*Outline16` | `Icon*OutlineRegular` 或 `Icon*OutlineMedium`（**没有 `Outline16`**） |

### 6.5 测试里有一个环境相关的失败

`test/system-proxy.test.ts > adds the system proxy to a child that has none` 在
本机会失败，因为 shell 里有小写 `http_proxy` / `https_proxy`，而 `hasProxyEnv` 大小写不敏感。
这不是代码问题。验证：

```sh
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
    -u ALL_PROXY -u all_proxy npx vitest run test/system-proxy.test.ts
# → 6 passed
```

---

## 7. 分支说明

| 分支 | 提交 | 用途 |
|---|---|---|
| `port/upstream-tracked` | `1490d87` | **工作主干**。真实合并历史，基点正确 |
| `backup/additive-state` | `abf125f` | 早期用 cherry-pick 做的同内容版本（内容与上面一致），备份 |
| `merge/upstream-0.1.63` | `1d6bb2e` | 旧的 squash 合并，仅作回退参考 |
| `backup/pre-merge-0.1.63` | `910ad6e` | 合并前的原始状态 |
| `feature/*`、`fix/*` | 各见第 2、3 节 | 各功能的原始开发分支 |

---

## 8. profile 侧的配置（与插件版本无关，别弄丢）

`~/.dsh/profiles/desktop/cordis.patch.yml` 里承载 0.2.0 的设置（0.2.0 起
`~/.dsh/settings.yaml` 的配置迁到了 profile 的 patch 文件），其中有：

- `llm-pi-ai` provider（`opencode-go`，`apiKeyEnv: OPENCODE_GO_API_KEY`）**及其 models 列表**
  （0.2.0 的自动迁移只搬了 provider，**models 会丢**，需要手工补回）
- `ui-chat` / `ui-settings` / `ui-settings-account` 的界面设置

profile 的依赖声明（`package.json`）：

```json
"dependencies": {
  "@norman-else/dsh-claude": "file:/Users/jack/.dsh/artifacts/norman-else-dsh-claude-<version>.tgz",
  "dsh-opencode-session": "0.1.1",
  "dshmarket": "1.66.5"
},
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
  "dshmarket", "dsh-opencode-session", "@norman-else/dsh-claude"
]}}
```

> ⚠️ `dshmarket` 锁定在 `1.66.5` 而不是 `^1.66.6`：官方 App 的 pnpm 有
> `minimumReleaseAge` 供应链策略，太新的版本会被拒（`PM_MINIMUM_RELEASE_AGE_VIOLATION`）。
