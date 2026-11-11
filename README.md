# @commonworks/agent-team

一个**纯插件**方案：用「父 agent fork 子 agent」模拟「子 agent 续跑」，并给成员之间加一块**共享留言板**，从而在 DSH 现有架构下实现"子 agent 之间互发消息"。

零依赖（运行时 import 任何 `@deepseek-ai/*` 包都不需要），以 `file:` 插件挂进官方 DSH，不改内核。

> 位置：本目录在仓库内但**不参与 pnpm workspace / 构建 / 门禁**，git 里是未跟踪状态。产物（账本、邮箱存储）默认写到 `$DSH_HOME/agent-team/lineage`，绝不落进用户仓库。

---

## 1. 为什么需要它（上游缺口）

核验官方 0.2.1-rc.5 / 0.2.2-rc.1 源码后确认：

| # | 能力 | 官方状态 |
|---|---|---|
| 1 | `fork` 的种子来源 | **只能**是委托方（父）的已完成轮次前缀 |
| 2 | provider 能否知道"用哪个会话当种子" | **没有通道**：`ContinuableCreateRequest` 只有 `{ cwd, sessionId, parent, signal }` |
| 3 | `startActivation` 复用已存在的 child id | 直接 `DUPLICATE_CHILD` |
| 4 | `sendMessage` 续跑 | 可用，但只有 `MessageId`，无结果回执、无 `activeOnly`、不能覆盖 `maxTokens/outputSchema` |
| 5 | 子 ↔ 子直接发消息 | **不存在**：授权只有 direct parent ↔ direct continuable child |

**本插件利用的缝隙**：`startActivation` 允许调用方自带 `childId`，而这个 id 会原样出现在 `prepareContinuable(request.sessionId)` 里。于是「childId → 用哪一代历史」这张表由插件自己持有——这就是缺的透传通道。

## 2. 设计

```
orchestrator plugin
  │  fork({ memberId, prompt })
  ├─► LineageJournal.reserve() ──► childId
  ├─► ctx.subagents.startActivation({ provider:'agent-team', childId, request })
  │        └─► prepareContinuable({ sessionId: childId })
  │                 ├─ journal.sourceOf(childId) → predecessor
  │                 ├─ 读 predecessor 日志 → buildForkSeed(events, completedTurnBoundary)
  │                 └─ journal.markPrepared(...)   ← 种子成功/失败都留痕
  └─► markStarted / markSettled / markFailed
```

四条关键决定：

1. **childId 当钥匙**：并发安全、重启可解析；不用可变槽位，也不用工厂造一堆 provider。
2. **显式 predecessor**：不用"计数器取下一个"，并发/重试不会分叉。
3. **准备结果持久化**：`prepare` 记录写明 `seeded:true/false` 与原因；没有这条，空白子会话与成功子会话事后无法区分。
4. **一次一代**：每代新建子会话，继承上一代 transcript；上一代在结算时由上游释放运行时（`local Activation … until settlement`），历史留在会话日志里——这就是"杀掉 + 转世"。

## 3. 与「真续跑」的差异

| | 转世（本插件） | 真续跑（`sendMessage` / 策略版 `continueActivation`） |
|---|---|---|
| 记忆连续 | ✅ 逐字复制上一代已完成轮次 | ✅ 同一会话 |
| 结果可断言 | ✅ 每代一个 `result` | ⚠️ sendMessage 只有 messageId |
| 会话身份 | ❌ N 个兄弟会话 | ✅ 一个成员多轮 |
| 加 persona/toolFilter | ⚠️ 改写请求头 → 前缀缓存失效 | ✅ 头不变 |
| 每代成本 | 复制整段历史（缓存友好但占窗口） | 只付自己那段 |
| 成员互发消息 | ✅ 共享留言板（见 5.2） | ❌ 只有父 ↔ 子 |

## 4. 文件结构

```
src/seed.js           buildForkSeed / openTurnClosers / ToolCallRecovery（对齐上游 fork.ts + repair.ts）
src/journal.js        血缘账本：reserve/prepare/start/settle/fail/head/chain/sourceOf
src/provider.js       SeededForkProvider（prepareContinuable + readSessionEvents + 留痕）
src/mailserver.js     邮箱服务器：成员互发邮件的持久化存储（原子写、按 reader 消费、跨代携带）
src/api.js            createSeededFork / JournalRegistry / 七个模型可见工具 / 护栏
src/playbook.js       策略手册文本 + preset 构建辅助
src/preset.js         克隆 standard 的 preset 构建 + 等待 standard + 注册
src/preset-entry.js   preset 作用域里的手册 section
src/preset-session.js preset 作用域里的首轮提示（agent/pre-step 注入 snapshot 消息）
src/index.js          cordis 函数插件入口（name / inject / apply，无 default export）
scripts/              verify-module.mjs（契约自检）/ demo.mjs（假 host 演示）/ inspect-session.mjs（解码会话）
profile/              独立 profile 挂载配方（已实测）
tests/                55 项 node:test
```

## 5. 用法

### 作为库

```js
import { createSeededFork } from '@commonworks/agent-team/api'

const seeded = createSeededFork(ctx, { directory: '/abs/state' })

const g1 = await seeded.fork({ parent: agent, memberId: 'audit', prompt: '审计鉴权路径' })
await g1.result

const g2 = await seeded.rotate({ parent: agent, memberId: 'audit', prompt: '复核你自己上一轮的发现' })
```

### 作为插件

```yaml
- insert:
    - id: agent-team
      name: file:///F:/code/DSH-Policy/.experiments/agent-team/src/index.js
      config: { directory: '...', providerName: agent-team, registerTools: true, playbook: false, preset: { id: strategy-mirror } }
```

挂载后 `ctx.get('seededFork')` 拿到 API，并注册七个工具：

| 工具 | 作用 |
|---|---|
| `seeded_fork` | 为 `member_id` 起一代子会话（`task` 是该代指令；`seed_from` 可指定前任） |
| `seeded_rotate` | 起该成员下一代，继承最新**已完成**的一代（未落定会等；跨进程明确报错） |
| `seeded_chain` | 列出世代、相位、前任 |
| `member_roster` | 列出本编排已登记的成员（精确的 `member_id` 与当前代次） |
| `member_post` | 给某成员留言；目标还不存在时**返回 warning 但不丢消息** |
| `member_inbox` | 读写给**自己地址**的消息（默认读完即消费）；编排者也有地址 `orchestrator`，但没有总览权 |
| `seeded_preset_diagnose` | 报告 preset 注册结果、错误、`standard` 是否可用 |

### 5.1 策略手册 + preset

只加系统提示不够。实测：手册在 system prompt、四个工具都在请求头（45 个工具），模型仍然自己读文件回答。所以用三层：

| 层 | 位置 | 作用 |
|---|---|---|
| persona 覆盖 | preset 的 `persona` 行 | 把 "coding agent" 换成 "strategy orchestrator: plan in stages, delegate before answering" |
| 系统提示 | `agent-team:strategy` section（order 2810） | 完整打法与五条约束 |
| 首轮提示 | `preset-session.js`：`agent/pre-step` 在 turn 1 step 1 注入 snapshot 用户消息 | 把「先出计划、第一波工具调用必须是 seeded_fork、用 rotate 复核」放在用户消息旁边 |

preset 注册参照兄弟项目 `dsh-starter`：**等 `standard` 出现 → 克隆它的插件行 → 追加两行（手册 + 首轮提示）→ 异步注册，失败只进诊断**。不要只塞孤立条目（会得到缺 persona/工具的 agent，且激活失败会在预设列表留下坏行——本项目踩过 `unknown preset standard`）。

### 5.2 邮箱服务器（mail server）

兄弟之间没有传输通道，所以走**邮箱服务器**：每个编排会话一个 `<sessionId>.mail.json`（与账本同目录，原子写 + EPERM 重试），每个参与者（含编排者）各有一个信箱。

寻址与投递规则：

- 只写 `to_member`：**任一代**都能读到，直到被某次读取消费——"给上一世没读的消息，仍会送到这一代"。
- 同时写 `to_generation`：只有那一代可见。
- 消费按 `childId` 记账：同一代不重复看到，后续代不继承已读消息。

**每步轮询**靠初始提示：`fork`/`rotate` 在任务前拼一段 preamble：

```
[member "review" generation 1]
Before each step, call member_inbox ... To reach another member, call member_roster for exact ids, then member_post.
```

子 agent 的轮次里没有我们可挂钩的插件事件，所以这是能做到的最强约束（提示 + 工具描述 + playbook）。

#### 信箱是点对点的，编排者也没有总览权

- 每个成员、以及编排者（保留地址 `orchestrator`），都只是一个**信箱**。
- 过滤规则只按收件人比对：`toMember === reader.memberId`。所以 a 发给 b 的信，c 查信箱时**看不到**；c 的查询也不会把 b 的信消费掉（消费按 reader 的 childId 记账）。
- 本插件没登记过的子会话（例如用原生 `subagent` 工具起的）查信箱返回空，而不是退化成"读整块板"。
- 编排者不再有 `all()` 总览：全量读取的方法已删除。它只能读到写给 `orchestrator` 的信。
- 给 `orchestrator` 投信不会触发自动唤醒（它不是成员代次），`member_post` 会返回 `no automatic wake: orchestrator`。

真机验证（headless，账本 `.state/mail-check/`）：

```
工具序列：seeded_fork → … → member_inbox → seeded_fork → member_inbox
邮箱存储：from=audit to=orchestrator topic=finding readers=session-c22a2344…
编排者第一次读：1 条（来自 audit）
producer 读：无消息
编排者第二次读：0 条（已被消费）
```
### 5.3 自动唤醒（留言触发转世）

场景：A 已经向父汇报并进入终止状态；随后 B 给 A 留言。A 的运行时已被释放，没人读这封信——**插件在 `member_post` 里自动给 A 转世**。

```
B.member_post({to_member:'audit'}) → 落盘 → 检查 audit 最新一代相位
   ├─ started   → 不唤醒（它这一轮会自己读）
   ├─ reserved  → 不唤醒（还没起来）
   └─ settled/failed →
        ├─ 预算（默认每人 2 次）用完 → 不唤醒，结果里写明 budget-exhausted
        ├─ 编排者不在线 → 不唤醒，结果里写明 orchestrator-not-live
        └─ 否则 rotate({ task: 唤醒指令 }) → 新代继承上一代 transcript → 读 inbox → 汇报
```

保护措施：

1. **只对终止态唤醒**：运行中的成员会在本轮自己读信，不再造一代。
2. **每人唤醒预算**（`autoWake.maxPerMember`，默认 2）：防 A↔B 无限互唤醒。
3. **同一成员同一时刻只允许一个唤醒在飞**（`already-waking`）。
4. **唤醒任务显式覆盖继承来的"已结束"指令**：实测第一版会让成员沿用旧任务（"只回答数字 1"）而无视新邮件，所以文本里写明"这封信比你上一轮更新，即使上一轮让你停止或改答别的"。
5. 唤醒结果作为 `member_post` 的返回值告知调用方（`started the next generation (…)` / `member is still running` / `no automatic wake: …`）。

配置：

```yaml
autoWake: { maxPerMember: 2 }     # 关闭：autoWake: false
```

真机验证（headless，账本 `.state/wake-check/`）：

```
audit  gen0  reserve → prepare → start → settle          ← 已终止
producer gen0 start →（其内部调用 member_post 给 audit）
audit  gen1  reserve → prepare → start → auto-wake → settle
邮箱存储：from=producer to=audit topic=ping readers=bed27276…   ← gen1 已读取
gen1 会话：isSeeded=true，工具调用 member_inbox, send_message
```

## 6. 验证

### 6.1 单元与契约测试

```sh
cd .experiments/agent-team
node --test tests/*.test.js      # 55 passed
node scripts/verify-module.mjs   # 加载契约 + playbook/preset 形状
node scripts/demo.mjs            # 假 host 的 fork → rotate → rotate 演示
```

覆盖：种子构造（含未返回 tool call 的合成闭合器）、账本相位与重启恢复、并发预留、代数上限、provider 降级路径、rotate 护栏（等落定 / 跨进程拒绝）、工具 schema 与注册开关、preset 克隆与 `standard` 缺失容错、首轮提示只注入一次、邮箱服务器的寻址/消费/跨代携带/持久化/未知目标 warning。

### 6.2 真实 DSH 客户端实测

环境：桌面版自带 CLI（`dsh --version` = 0.2.2-rc.1），独立 profile 由 `headless` / `web` 模板克隆，**未触碰 desktop 逻辑**。

| 场景 | 证据 |
|---|---|
| 转世继承 | 账本 `prepare seeded:true, boundary=32, inheritedEvents=33`；子会话 `inherited 34 events, marker at seq 34`，正文是上一代回答 |
| 前缀缓存 | 第二代首个自有请求 `inputTokens=195, cacheReadTokens=15360` |
| 池不泄漏 | 把 `maxActiveSubagents` 覆盖成 2，连跑 5 代全部成功，无 `ACTIVATION_LIMIT_REACHED` |
| 成员留言 | 工具序列 `member_post → seeded_fork`；邮箱存储 `from=orchestrator to=review text topic=ping readers=<childId>`；成员回答 "42" |
| preset 注册 | `agent-team: presets registered=[strategy-mirror] errors=[]` |
| 手册落 prompt | 会话解码：`systemMessages=1`，含 `## Author strategy (agent-team)` |

### 6.3 真机跑出来、单测跑不出来的缺陷（均已修复）

1. `ctx.tools` / `ctx.sessions` 未 `inject` 直接读 → cordis 抛错。改为只用 `ctx.get(name)`。
2. `ctx.seededFork = api` 被 cordis 拒绝。改为 `ctx.provide('seededFork', api)` + effect 释放。
3. `assertSupportedJsonSchema` 不接受 `type: ['string','null']`。改为单一类型。
4. 代码注册 preset 会污染预设列表（`unknown preset standard`，新建会话失败）。改为克隆 `standard` 的异步 best-effort 注册。
5. 模型在子任务落定前调用 `rotate` → 种子为空、静默投胎成空白。现在 `rotate` 等同进程内前一代落定，跨进程明确报错。

## 7. 还没验证 / 风险

**还没验证**

1. 血缘进会话日志那一层：`appendPluginRecord` 是 `@deepseek-ai/dsh-session` 的模块级导出，外部插件 import 不到宿主副本，`appendRecordFor` 目前没人注入；文件镜像才是唯一 durable 存储。
2. 跨进程冷缘：`rotate` 只等本进程内运行中的前一代；重启后遇到 `started` 相位会报错。
3. persona/toolFilter 下的缓存收益：只验证了不加的情形。
4. `buildForkSeed` 与上游实现未做同一输入的逐字节比对（行为一致）。
5. 成员"每步查收件箱"依赖模型遵守提示，没有强制钩子。

**已知风险**

1. childId 预留即消耗：`DUPLICATE_CHILD` 后不可回收，`maxGenerations` 是硬上限（默认 16）。
2. 每代复制整段历史：会话文件与 catalog 条目随代数增长。
3. persona/toolFilter 毁掉前缀复用（上游设计使然）。
4. provider 名唯一：重复注册抛 `DUPLICATE_PROVIDER`。
5. 账本与邮箱存储目录必须在仓库外。
6. `snapshotEvents()` 已被上游标记 deprecated，未来改用持久化/查询路径。
7. `inspect-session.mjs` 的 zstd 切帧是启发式（压缩负载出现魔数会切错），只用于巡检。
8. 改完插件代码必须**重启客户端**：ESM 模块缓存不会因热重载重新求值。

## 8. 可以接着做的

1. 把血缘接进会话日志（注入 `appendPluginRecord`）。
2. 量 persona 对缓存的影响（对照实验）。
3. 压存储：代数上限 + 最老一代冻结成 workspace 档案。
4. 模型可见的代数提示：把 `generation` 与前任结论摘要写进该代初始 task。
5. 把 `.state/` 换到 `$DSH_HOME`，`--dump-config` 断言进 CI。
6. 给成员加"硬看板"：把 `member_inbox` 结果作为每步的 runtime context 注入（需要内核钩子，目前做不到）。

## 9. 复现清单

```sh
cd .experiments/agent-team && node --test tests/*.test.js && node scripts/verify-module.mjs

DSH_CLI="C:/Users/aivm/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
"$DSH_CLI" agent-team-smoke --from-default-profile headless --dump-config   # 建一次性 profile
# 写 cordis.patch.yml（见 profile/cordis.patch.yml），然后：
"$DSH_CLI" agent-team-smoke --json --approval-policy never "…"
node scripts/inspect-session.mjs ~/.dsh/sessions/*/<child-id>/session.v4.jsonl.zstd
```

## 10. desktop profile 安装

`~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加（其余条目未动；备份 `cordis.patch.yml.bak-before-preset`）：

```yaml
- insert:
    - id: agent-team
      name: file:///F:/code/DSH-Policy/.experiments/agent-team/src/index.js
      config:
        directory: C:/Users/aivm/.dsh/agent-team/lineage
        providerName: agent-team
        maxGenerations: 8
        maxDepth: 1
        delivery: caller
        registerTools: true
        playbook: false
        preset:
          id: strategy-mirror
          name: Strategy mirror (agent-team)
          order: 7
```

回滚：

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-before-preset" "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
```

CLI 不能 dump desktop profile（`managed exclusively by the Electron application`），所以每次改 patch 都先在一次性 profile 里用同样文本验证组合与真机加载，再写进 desktop。
