# @commonworks/agent-team

给 DeepSeek Harness 的**纯插件**智能体团队运行时：用「父 agent fork 子 agent」实现子 agent 的代际延续，并配一个**点对点邮箱服务器**，让成员之间能在不改内核的前提下互相通信。

- 零运行时依赖（不 import 任何 `@deepseek-ai/*` 包），以 `file:` 插件挂进 DSH。
- 不改 `agent-loop`、不改 `dsh-subagent`。
- 当前状态：**64 项单测全绿**，已在真实 DSH 客户端（0.2.2-rc.1）跑通代际继承、成员互发邮件、终止态自动唤醒。

> 目录位置：`.experiments/agent-team/`。不参与 DSH 仓库的 pnpm workspace / 构建 / 门禁，git 里是未跟踪状态。
> 运行时数据（账本、邮箱存储）默认写到 `$DSH_HOME/agent-team/lineage`，不落进用户仓库。

---

## 1. DSH 的能力边界

本插件只依赖 DSH 本体已有的接口。下面这些边界决定了设计：

| # | DSH 现状 | 后果 |
|---|---|---|
| 1 | `fork` 的种子只能是委托方（父）的已完成轮次前缀 | 子会话无法从"另一个子会话"继承历史 |
| 2 | `ContinuableCreateRequest` 只有 `{ cwd, sessionId, parent, signal }` | provider 拿不到"用哪个会话当种子"的参数 |
| 3 | `startActivation` 复用已存在的 child id → `DUPLICATE_CHILD` | 一个会话不能被"重启"成新的一代 |
| 4 | `sendMessage` 只返回 `MessageId` | 投递成功不可断言为"这一轮的结果" |
| 5 | 消息授权只有 direct parent ↔ direct continuable child | 兄弟成员之间没有传输通道 |
| 6 | 本地 Activation 在结算时释放 AgentHandle | 结算后的成员没有运行时可以接收新输入 |

**本插件利用的缝隙**：`startActivation` 允许调用方自带 `childId`，而这个 id 会原样出现在 `prepareContinuable(request.sessionId)` 里。于是「childId → 用哪一代历史」这张表由插件自己持有——这就是缺口 2 缺的透传通道。

## 2. 设计

```
orchestrator plugin
  │  fork({ memberId, prompt })
  ├─► LineageJournal.reserve() ──► childId（显式 predecessor）
  ├─► ctx.subagents.startActivation({ provider:'agent-team', childId, request })
  │        └─► prepareContinuable({ sessionId: childId })
  │                 ├─ journal.sourceOf(childId) → predecessor
  │                 ├─ 读 predecessor 日志 → buildForkSeed(events, completedTurnBoundary)
  │                 └─ journal.markPrepared(...)      ← 种子成功/失败都留痕
  └─► markStarted / markSettled / markFailed
```

四条关键决定：

1. **childId 当钥匙**：并发安全、重启可解析；不用可变槽位，也不用工厂造一堆 provider。
2. **显式 predecessor**：不用"计数器取下一个"，并发/重试不会分叉；启动即被拒的代数会被跳过而不是被误认。
3. **准备结果持久化**：`prepare` 记录写明 `seeded:true/false` 与原因；没有这条，空白子会话与成功子会话事后无法区分。
4. **一次一代**：每代新建子会话继承上一代 transcript；上一代的运行时在结算时由 DSH 释放，历史留在会话日志里。

## 3. 安装与配置

### 从 npm 安装到 profile（推荐）

```sh
# CLI 管理的 profile（headless / web / 自建 profile）
dsh plugin --profile <name> add @commonworks/agent-team
```

桌面版（desktop profile 由 Electron 管理，CLI 不能改）在 GUI 的 **Plugins** 页安装 `@commonworks/agent-team`。

包内自带组合层（`dsh.bundle.patch` → `cordis.patch.yml`），安装后会自动挂载：subagent 后端、七个成员工具、以及名为 **智能体团队**（id `agent-team`）的 agent preset。per-deployment 参数（状态目录、provider 名、唤醒预算）可在 profile patch 里按条目 id `agent-team` 覆盖。

> 注意：`headless` 组合没有 `agentPresets` 服务，因此该 profile 下 preset 不会出现（工具照常可用）；preset 只存在于 web / desktop 这类带预设注册表的组合里。插件会在启动日志里明确写出这一点。

#### preset 不出现时怎么查

插件在两种情况下会**直接打印**原因（不需要 debug 开关）：

```
agent-team: preset "agent-team" was requested but this composition has no agentPresets service; …
agent-team: preset "agent-team" was not registered: <原因>
```

按顺序核对：

| 检查 | 命令 / 位置 | 期望 |
|---|---|---|
| 装的是 0.1.2+ | `npm view @commonworks/agent-team version` | `0.1.3` 或更高（0.1.0/0.1.1 缺 `dsh.bundle`，0.1.1 还带 BOM） |
| 确实装进了 profile | `~/.dsh/profiles/<名>/node_modules/@commonworks/agent-team/package.json` | 文件存在且 `version` 匹配 |
| 组合里挂上了 | `dsh --profile <名> --dump-config`（GUI 管理的 desktop 用 GUI 看） | 有 `id: agent-team` 条目 |
| 组合带预设注册表 | 启动日志 | 出现 `agent-team: presets registered=[agent-team]`（需 `DSH_AGENT_TEAM_DEBUG=1`）或没有任何 agent-team 报错 |
| 装完重启过 | — | ESM 模块缓存不会热更新；装包后必须重启客户端，再开**新会话** |

### 手工挂载（file: 插件，源码工作区）

```yaml
- insert:
    - id: agent-team
      name: file:///F:/code/DSH-Policy/.experiments/agent-team/src/index.js
      config:
        directory: C:/Users/aivm/.dsh/agent-team/lineage
        providerName: agent-team
        maxGenerations: 8          # 每个成员的代数上限
        maxDepth: 1                # 子 agent 不再委派
        delivery: caller           # caller=只返结果；parent=额外通知父
        registerTools: true
        playbook: false            # 手册只由 preset 携带
        preset:
          id: agent-team
          name: 智能体团队
          order: 7
        autoWake: { maxPerMember: 2 }   # 关闭用 autoWake: false
```

`DSH_AGENT_TEAM_DEBUG=1` 会把 preset 注册结果打到 stderr。**改完插件代码必须重启客户端**：ESM 模块缓存不会因热重载重新求值。

### 作为库

```js
import { createSeededFork } from '@commonworks/agent-team/api'

const team = createSeededFork(ctx, { directory: '/abs/state' })

const g1 = await team.fork({ parent: agent, memberId: 'audit', prompt: '审计鉴权路径' })
await g1.result

const g2 = await team.rotate({ parent: agent, memberId: 'audit', prompt: '复核你自己上一轮的发现' })
```

## 4. 工具

挂载后 `ctx.get('seededFork')` 拿到 API，并注册七个模型可见工具：

| 工具 | 作用 |
|---|---|
| `seeded_fork` | 为 `member_id` 起一代子会话（`task` 是该代指令；`seed_from` 可指定前任） |
| `seeded_rotate` | 起该成员下一代，继承最新**已完成**的一代（未落定会等；跨进程明确报错） |
| `seeded_chain` | 列出世代、相位、前任 |
| `member_roster` | 列出本编排已登记的成员（含 `orchestrator` 地址） |
| `member_dispatch` | 按信箱内容按需造转世：把未读邮件按收件人分组，给每个收件成员起下一代（正在跑的跳过） |
| `member_post` | 给某成员或 `orchestrator` 投信；**目标必须已存在**（未启动的 id 直接拒绝）；目标已终止时自动转世 |
| `member_inbox` | 读写给**自己地址**的邮件（默认读完即消费），并报告**服务器总量**与其中"不是给自己的"条数 |
| `seeded_preset_diagnose` | 报告 preset 注册结果、错误、`standard` 是否可用 |

## 5. preset 与提示层

只加系统提示不够：实测手册在 system prompt、工具也都在请求头，模型仍可能自己读文件回答。所以 preset 用三层：

| 层 | 位置 | 作用 |
|---|---|---|
| persona 覆盖 | preset 的 `persona` 行 | 把 persona 换成"分阶段计划、先派成员再回答"的角色 |
| 系统提示 | `agent-team:strategy` section（order 2810） | 完整打法与五条约束 |
| 首轮提示 | `preset-session.js`：`agent/pre-step` 在 turn 1 step 1 注入 snapshot 用户消息 | 把「先出计划、第一波工具调用必须是 seeded_fork、用 rotate 复核」放在用户消息旁边 |

preset 的注册方式：**等 `standard` 出现 → 克隆它的插件行 → 追加两行（手册 + 首轮提示）→ 异步注册，失败只进诊断**。

不要只塞一个孤立条目：`agentPresets.register()` 先写定义后激活，激活失败不回滚，会在预设列表留下坏行，表现为新建会话失败。

## 6. 邮箱服务器（mail server）

兄弟之间没有传输通道，所以走**邮箱服务器**：每个编排会话一个 `<sessionId>.mail.json`（与账本同目录，原子写 + EPERM 重试），每个参与者各有一个信箱。

- **点对点**：过滤只按收件人比对（`toMember === reader.memberId`）。a 发给 b 的邮件，c 查信箱时看不到；c 的查询也不会消费 b 的邮件（消费按 reader 的 `childId` 记账）。
- **信箱属于成员，不属于某一世**：`member_inbox` 默认返回该成员的**整份信箱**，其中上一代已经处理过的标注 `state: "handled-earlier"`；新一代不会看到"空信箱"。读取按 reader 记账（同一代不重复看到），**邮件不区分代次**——它属于成员，谁在跑就谁读。
- **坏文件不覆盖**：存储无法解析时，先把原文件改名为 `<file>.corrupt-<时间戳>` 再写新文件，避免"解析失败 → 写成空表 → 邮箱被清空"。
- **编排者也是信箱**：保留地址 `orchestrator`，成员可以给它投信；它没有总览权（全量读取的方法不存在），只能读到写给自己的邮件。
- **非成员子会话**（例如用 DSH 原生 `subagent` 工具起的）查信箱返回空。
- **服务器总量可见、内容不可见**：`member_inbox` 除了返回自己的邮件，还返回 `total`（服务器上的全部条数）与 `others`（其中不是给自己的条数）。知道"还有信"是必要的，"读别人的信"仍然不允许。
- **每步轮询**靠 `fork`/`rotate` 拼在任务前的 preamble：

```
[member "review" generation 1]
Before each step, call member_inbox ... To reach another member, call member_roster for exact ids, then member_post.
```

子 agent 的轮次里没有可挂钩的插件事件，所以这是能做到的最强约束（提示 + 工具描述 + playbook）。

#### 死信与租约

"派发"不是盖章，是**租约**：`member_dispatch` 把邮件记成 `dispatchedTo = <childId>`，但只要没人真正读过它，它仍然留在 `pending` 里。

| 情况 | 现在的行为 |
|---|---|
| 收件成员不存在（历史遗留或外部写入的信） | 派发时**按需创建**该成员（generation 0）；新写入已被 `member_post` 的校验挡住 |
| 收件成员正在跑 | 跳过，它这一轮会自己读 |
| 派发出的那一代结算了却没读 | 租约过期，下次 `member_dispatch` 会为新的一代重新派发 |
| 该成员达代数上限 / 创建失败 | 进 `stuck`（带原因与未读数），邮件保持未读，不假装处理过 |
| 同名成员两次派发并发 | 每成员一把锁，第二次报 `a dispatch is already starting a generation` |
| 写给 `orchestrator` 的信 | 不由 `member_dispatch` 处理，结果里用 `unclaimed` 提示主 agent 自己去 `member_inbox` 读 |
| 某代结算时自己信箱还有未读 | **结算即自愈**：插件直接给它起下一代（`reason: unread-mail-retry`），不必等主 agent 再轮询 |

自愈的重试有独立预算（`mailRetry.maxPerMember`，默认 2，配置 `mailRetry: false` 可关闭），所以"一直不读信"的成员不会无限转世；重试与派发、自动唤醒共用同一把每成员锁，不会同时给一个人起两代。
结果里因此多了两个字段：`stuck`（拿不到转世的邮件）和 `unclaimed`（写给主 agent 自己、还没读的条数）——两条都会出现在工具输出里，不会被静默吞掉。
#### 协作关系由编排者设计，不由成员自己摸索

成员之间默认太"安静"：每个成员只管做完自己的 task 就上报，所有协调都绕主 agent 转述。所以提示分两层：

| 层 | 内容 |
|---|---|
| 编排者的 playbook / 首轮提示 | 派任务时必须同时填 `peers`（每个队友的 `member` / `relationship` / `when`）与 `report_when`（什么时候升级给编排者）。编排者是调度者和仲裁者，不是交换机。 |
| 成员的 preamble（`fork`/`rotate` 自动拼接） | 把 `peers` 渲染成"队友 + 关系 + 何时直接找它"，再补上汇报规则与收信规则；`rotate` 未显式声明时继承上一代的 links |

生成的 preamble 长这样：

```
[member "audit" generation 1]
Your peers are "orchestrator", "ground", "produce". When you need a fact, a check,
or a hand-off, message that peer directly with member_post instead of asking the
orchestrator to relay it; the orchestrator is for decisions and scope, not for
passing notes between members.
Before each step, call member_inbox ...
```

同伴名单来自账本里已登记的成员（`memberRoster`），自己不会出现在名单里。
#### 信箱不空时：按邮件造转世

主 agent 收信有**两条渠道**，两条都会报服务器总量：

| 渠道 | 触发 | 带上来的信息 |
|---|---|---|
| `member_inbox` 工具结果 | 主动轮询 | 自己的邮件 + `total` / `others` |
| 结算通知 | 某个成员上一代结算时，插件向父会话追加一条 snapshot 用户消息 | `total` / `others`（保证"收到子 agent 结果"这一刻就能看到） |

总量大于 0 时，主 agent **不给结论**，而是调用 `member_dispatch`：

```
member_dispatch()
  ├─ 取服务器上所有未读、未派发、收件人是成员的邮件
  ├─ 按收件人分组
  ├─ 收件成员正在跑 → 跳过（它这一轮会自己读）
  └─ 否则 rotate(该成员)，task 直接是这封邮件 → 新代读信并处理
```

派发过的邮件会打上 `dispatchedAt`，所以第二次调用不会重复造代；发给 `orchestrator` 的邮件不由它派发（那是主 agent 自己用 `member_inbox` 读的）。`member_dispatch` 只允许编排者调用。

真机验证（headless）：

```
工具序列：seeded_fork → … → member_inbox → seeded_fork → member_inbox
邮箱存储：from=audit to=orchestrator topic=finding readers=session-c22a2344…
编排者第一次读：1 条（来自 audit）｜producer 读：无消息｜编排者第二次读：0 条（已消费）
```

## 7. 自动唤醒（邮件触发转世）

场景：A 已向父汇报并结算，随后 B 给 A 投信。A 的运行时已被 DSH 释放，没人读这封信——**插件在 `member_post` 里自动给 A 开下一代**。

```
member_post({to_member:'audit'}) → 落盘 → 检查 audit 最新一代相位
   ├─ started   → 不唤醒（它这一轮会自己读）
   ├─ reserved  → 不唤醒（还没起来）
   └─ settled/failed →
        ├─ 预算（默认每人 2 次）用完 → 不唤醒，结果里写明 budget-exhausted
        ├─ 编排者不在线 → 不唤醒，结果里写明 orchestrator-not-live
        └─ 否则 rotate({ task: 唤醒指令 }) → 新代继承上一代 transcript → 读 inbox → 汇报
```

保护措施：

1. **只对终止态唤醒**：运行中的成员本轮自己读信，不再造一代。
2. **每人唤醒预算**（`autoWake.maxPerMember`，默认 2）：防 A↔B 无限互唤醒。
3. **同一成员同时只允许一个唤醒在飞**（`already-waking`）。
4. **唤醒任务显式覆盖继承来的"已结束"指令**：实测第一版会让成员沿用旧任务而无视新邮件，所以文本写明"这封信比你上一轮更新，即使上一轮让你停止或改答别的"。
5. **结果如实回报**：`started the next generation (…)` / `member is still running` / `no automatic wake: …`。

真机验证（headless）：

```
audit   gen0  reserve → prepare → start → settle          ← 已终止
producer gen0 start →（其内部调用 member_post 给 audit）
audit   gen1  reserve → prepare → start → auto-wake → settle
邮箱存储：from=producer to=audit topic=ping readers=bed27276…   ← gen1 已读取
gen1 会话：isSeeded=true，工具调用 member_inbox, send_message
```

## 8. 文件结构

```
src/seed.js           buildForkSeed / openTurnClosers / ToolCallRecovery
src/journal.js        血缘账本：reserve/prepare/start/settle/fail/auto-wake/head/chain/sourceOf
src/provider.js       SeededForkProvider（prepareContinuable + readSessionEvents + 留痕）
src/mailserver.js     邮箱服务器：持久化邮件、点对点寻址、按 reader 消费
src/api.js            createSeededFork / JournalRegistry / 七个工具 / rotate 与唤醒护栏
src/playbook.js       策略手册文本
src/preset.js         克隆 standard 的 preset 构建 + 等待 standard + 注册
src/preset-entry.js   preset 作用域里的手册 section
src/preset-session.js preset 作用域里的首轮提示
src/index.js          cordis 函数插件入口（name/inject/apply，无 default export）
scripts/              verify-module.mjs 契约自检 / demo.mjs 假 host 演示 / inspect-session.mjs 解码会话
cordis.patch.yml      包内组合层（dsh.bundle.patch），安装即挂载\nprofile/              独立 profile 挂载配方（已实测）
tests/                64 项 node:test
```

## 9. 验证

```sh
cd .experiments/agent-team
node --test tests/*.test.js      # 64 passed
node scripts/verify-module.mjs   # 加载契约 + playbook/preset 形状
node scripts/demo.mjs            # 假 host 的 fork → rotate → rotate 演示
```

覆盖：种子构造（含未返回 tool call 的合成闭合器）、账本相位与重启恢复、并发预留、代数上限、provider 降级路径、rotate 护栏（等落定 / 跨进程拒绝）、工具 schema 与注册开关、preset 克隆与 `standard` 缺失容错、首轮提示只注入一次、邮箱的寻址/消费/跨代携带/持久化/未知目标 warning/非成员隔离/终止态唤醒/唤醒预算。

真实 DSH 客户端（桌面版自带 CLI，`dsh --version` = 0.2.2-rc.1；独立 profile 由 `headless` / `web` 模板克隆）：

| 场景 | 证据 |
|---|---|
| 代际继承 | 账本 `prepare seeded:true, boundary=32, inheritedEvents=33`；子会话 `inherited 34 events, marker at seq 34`，正文是上一代回答 |
| 前缀缓存 | 第二代首个自有请求 `inputTokens=195, cacheReadTokens=15360` |
| 池不泄漏 | `maxActiveSubagents` 覆盖成 2，连跑 5 代全成功，无 `ACTIVATION_LIMIT_REACHED` |
| 成员投信 | `member_post → seeded_fork`；成员读到邮件并按内容作答 |
| 编排者信箱 | 成员给 `orchestrator` 投信，编排者只读到写给自己的 1 条；其他成员读不到 |
| 自动唤醒 | audit gen0 结算 → producer 投信 → audit gen1 以 `auto-wake` 记录被创建并读取 |
| preset 注册 | `agent-team: presets registered=[agent-team] errors=[]` |
| 手册落 prompt | 会话解码：`systemMessages=1`，含 `## Author strategy (agent-team)` |

## 10. 真机跑出来、单测跑不出来的缺陷（均已修复）

1. `ctx.tools` / `ctx.sessions` 未 `inject` 直接读 → cordis 抛错。改为只用 `ctx.get(name)`。
2. `ctx.seededFork = api` 被 cordis 拒绝。改为 `ctx.provide('seededFork', api)` + effect 释放。
3. `assertSupportedJsonSchema` 不接受 `type: ['string','null']`，也不接受过宽对象项。改为单一类型。
4. 代码注册 preset 会污染预设列表，导致新建会话失败。改为克隆 `standard` 的异步 best-effort 注册。
5. 模型在子任务落定前调用 `rotate` → 种子为空、静默投胎成空白。现在 `rotate` 等同进程内前一代落定，跨进程明确报错。
6. 仅有系统提示时模型不派成员。补 persona 覆盖 + 首轮 snapshot 提示。

## 11. 还没验证 / 风险

**还没验证**

1. 血缘进会话日志那一层：`appendPluginRecord` 是 `@deepseek-ai/dsh-session` 的模块级导出，外部插件 import 不到宿主副本，`appendRecordFor` 目前没人注入；文件镜像才是唯一 durable 存储。
2. 跨进程：`rotate` 只等本进程内运行中的前一代；重启后遇到 `started` 相位会报错。
3. persona/toolFilter 下的缓存收益：只验证了不加的情形。
4. 成员"每步查信箱"依赖模型遵守提示，没有强制钩子。

**已知风险**

1. childId 预留即消耗：`DUPLICATE_CHILD` 后不可回收，`maxGenerations` 是硬上限（默认 16）。
2. 每代复制整段历史：会话文件与 catalog 条目随代数增长。
3. persona/toolFilter 会改写请求头，使前缀缓存失效（DSH 行为）。
4. provider 名唯一：同一 profile 重复注册抛 `DUPLICATE_PROVIDER`。
5. 账本与邮箱存储目录必须在仓库外。
6. `snapshotEvents()` 已被 DSH 标记 deprecated，未来改用持久化/查询路径。
7. `inspect-session.mjs` 的 zstd 切帧是启发式（压缩负载出现魔数会切错），只用于巡检。
8. 唤醒与转世都要求**编排者 agent 在线**；编排会话结束后投信仍会落盘，但要等下次编排者起来才被读取。

## 12. 可以接着做的

1. 把血缘接进会话日志（注入 `appendPluginRecord`）。
2. 量 persona 对缓存的影响（对照实验）。
3. 压存储：代数上限 + 最老一代冻结成 workspace 档案、只传路径。
4. 模型可见的代数提示：把 `generation` 与前任结论摘要写进该代初始 task。
5. 给成员"硬看板"：把 `member_inbox` 结果作为每步 runtime context 注入（需要内核钩子，目前做不到）。
6. 广播语义：`member_post({ broadcast: true })`，仍按 reader 各自记账，不引入"读全站"。

## 13. 复现清单

```sh
cd .experiments/agent-team && node --test tests/*.test.js && node scripts/verify-module.mjs

DSH_CLI="C:/Users/aivm/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
"$DSH_CLI" agent-team-smoke --from-default-profile headless --dump-config   # 建一次性 profile
# 把 profile/cordis.patch.yml 写进该 profile，然后（凭据从 ~/.dsh/.credentials.yaml 注入 DEEPSEEK_API_KEY）：
"$DSH_CLI" agent-team-smoke --json --approval-policy never "…"
node scripts/inspect-session.mjs ~/.dsh/sessions/*/<child-id>/session.v4.jsonl.zstd
```

CLI 不能 dump `desktop` profile（`managed exclusively by the Electron application`），所以每次改 patch 都先在一个一次性 profile 里用**同样字节**的 patch 验证组合与真机加载，再写进 desktop。
