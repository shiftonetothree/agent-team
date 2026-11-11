# 独立 profile 的挂载配方（已实测执行）

本目录是**已跑通**的配方，不是理论示例。用它可以在同一个 DSH 客户端上验证插件，而不碰 `desktop` profile。

## 为什么必须独立 profile

插件会注册一个 subagent backend（名字固定），失败时会让该 profile 的所有委派失败。独立 profile 出问题随手删掉即可。

## 建 profile

用桌面版自带的 CLI（`resources/runtime/cli/bin/dsh.cmd`）：

```sh
"$DSH_CLI" agent-team-smoke --from-default-profile headless --dump-config
```

这会在 `~/.dsh/profiles/agent-team-smoke/` 生成 `cordis.yml`（空根）、`cordis.patch.yml`（用户层）、`package.json`（bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`）。

`headless` 模板已包含 `subagents`、`tools`、`tool-subagent`、`subagent-fork-in-process`，所以插件能直接挂。

## 挂载插件

把下面内容写进 `~/.dsh/profiles/agent-team-smoke/cordis.patch.yml`（本目录的 `cordis.patch.yml` 就是这份）：

```yaml
- insert:
    - id: agent-team
      name: file:///F:/code/DSH-Policy/.experiments/agent-team/src/index.js
      config:
        directory: F:/code/DSH-Policy/.experiments/agent-team/.state
        providerName: agent-team
        maxGenerations: 8
        maxDepth: 1
        delivery: caller
        registerTools: true
```

用 `--dump-config` 确认组合结果里出现了该条目（`--dump-config` 只组合不挂载，不能证明模块可解析；真正的加载验证要靠一次真跑）。

## 跑一次真任务

```sh
# 凭据：桌面版把 key 存在 ~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY
# 取出来注入环境变量即可（不要打印到日志）
export DEEPSEEK_API_KEY=...

"$DSH_CLI" agent-team-smoke --json --approval-policy never \
  "先调用 seeded_fork（member_id=probe，task=列出工作目录前 3 个文件名），等它完成后调用 seeded_rotate（member_id=probe，task=只根据继承到的历史回答上一代列了哪三个文件）"
```

## 该看哪五个信号

| 信号 | 期望 | 怎么看 |
|---|---|---|
| 插件真的起来了 | stderr 里**没有** `1 entry did not activate` | 运行时 stderr |
| 工具注册 | 运行事件里出现 `"tool":"seeded_fork"` / `"seeded_rotate"` | `--json` 输出 |
| 账本 | `reserve → prepare → start → settle`，第二代 `prepare` 里 `seeded:true` | `.state/<parent-session-id>.json` |
| 种子落库 | 子会话 header `isSeeded:true`；日志里 `session/end-seed`；继承的 assistant 正文 | `node scripts/inspect-session.mjs <child session.v4.jsonl.zstd>` |
| 缓存命中 | 第二代首个自有请求 `cacheReadTokens` 明显大于 `inputTokens` | 同上脚本的 `usages` 行 |

## 实测发现的两个环境坑

1. **控制台编码**：用 PowerShell 把中文任务当命令行参数传给 `dsh` 会变成乱码（模型收到的就是乱码）。任务文本走 stdin（`- ` + UTF-8 文件）或用英文任务。
2. **profile 可直接重建**：`--from-default-profile headless` 会覆盖同名自定义 profile，实验弄脏了随时重建，不影响 `desktop`。

## 这个配方证明不了什么

- **打包版桌面进程内的行为**：桌面版从 `app.asar` 运行，`file:` 插件条目是给 CLI/源码启动路径用的。
- **persona/toolFilter 下的缓存**：加了角色约束会改写请求头，实测只覆盖了不加的情形。
- **跨进程冷缘**：`rotate` 只等本进程内的前一代；重启后遇到未落定的前代会明确报错。
