# openclaw-team-in-feishu

> 让你已有的 OpenClaw 智能体在飞书群里**协作讨论**。两种内置模式：**轮流发言**（主持人按顺序点名）、**自由发言**（成员自主决定要不要插话）。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

[English](README.md) · 简体中文

---

## 概述

你已经用 OpenClaw 做了 N 个智能体，每个都能单独跑。本项目把它们接到一个或多个飞书群里围着一个议题协作：用户 @ 主持人 bot 抛话题 → 主持人开 thread → 成员依次发言 → 主持人在讨论收敛时输出结束语。

**它做什么**

1. 监听每个飞书群主聊天里对主持人 bot 的 @-mention
2. 调用主持人 agent 开 thread 并确认话题
3. 用两种模式之一驱动后续对话（按群配置）
4. 主持人输出收口关键字（默认 `[END]`）后停止

**它不做的事**

- 不创建 OpenClaw 智能体（用 OpenClaw 自己的 CLI）
- 不是通用的飞书 bot 框架

> **v0.1.2 契约变更。** 从 v0.1.2 开始，daemon 接管**所有**消息分发——每个 bot 的 OpenClaw 飞书插件都必须 **disabled**。之前"主持人 disabled / 成员 enabled"的非对称配置已经废弃。这个改动解锁了"同一个 agent 服务多个飞书群"的能力。从 v0.1.1 升级请看 [docs/upgrading.md](docs/upgrading.md)。

---

## 实现原理

```
                    ┌──────────────────────────────────────┐
                    │  飞书 OpenAPI（open.feishu.cn）       │
                    └────────▲────────────────▲────────────┘
              poll 主聊天     │                │ 发回复
              （检测 @host）  │                │ （reply_in_thread:true）
                             │                │
              ┌──────────────┴────────────────┴──────────────┐
              │  octf daemon                                 │
              │  （单进程，每个群一个独立 async loop，         │
              │    per-agent 全局 mutex 串行化所有 invoke）    │
              └────────▲────────────────────┬────────────────┘
                       │                    │ execFileSync
            transcript │                    │ "openclaw agent
            （per-     │                    │  --agent X
            invoke     │                    │  --message <transcript+任务>"
            注入）     │                    ▼
            ┌──────────┴───────┐   ┌──────────────────────┐
            │ /shared/         │   │  openclaw gateway    │
            │ transcript-*.md  │   │  每 agent 的 SOUL    │
            │ （daemon 内部     │   │  飞书插件状态：       │
            │  bookkeeping）    │   │   全部 DISABLED      │
            └──────────────────┘   │   （daemon 自己发回复）│
                                   └──────────┬───────────┘
                                              │ stdout: agent 的回复文本
                                              ▼
                                    daemon 用对应 bot 的 token POST →
                                    回复进入 thread
```

### 三个核心契约

1. **讨论规则在 `SOUL.md` 里，不在 daemon。** 发言顺序、最大轮数、何时输出 `[END]`、何时输出 `[SKIP]` —— 全部由各 agent 的 LLM 看 `SOUL.md` 自觉遵守。daemon 只做机制：轮询、把 transcript 注入到 prompt、fork openclaw、发回复。换讨论形式（debate / review / brainstorm）只改 SOUL.md，daemon 一行不动。
2. **所有 bot 的 OpenClaw 飞书插件都必须 disabled。** daemon 接管所有回复：监听 thread → 用 CLI 调对应 agent（把当前 transcript 注入到 prompt）→ 用该 bot 的 token 自己 POST 到飞书。任何一个 bot 的 native 插件没关，就会双发——daemon 启动时会硬检查这一点。
3. **transcript 文件是 daemon 私有状态。** 每个 thread 的 transcript 由 daemon 写到 `transcript-<thread_id>.md`，并按 chat 镜像一份到 `transcript-<chat_id>.md`。**agent 不再 `cat` 这些文件**——daemon 在每次调用时把相关 transcript 直接塞进 prompt。这把 `SOUL.md` 与具体 chat 解耦，正是"同一个 agent 服务多个飞书群"得以成立的前提。

### 两种模式对比

| | round-robin（轮流发言） | free-speak（自由发言） |
|---|---|---|
| 谁决定下一个发言 | 主持人按 SOUL.md 顺序 @ 下一位 | daemon 用 `[SKIP]` 选项轮询每位 agent，agent 自决 |
| 成员触发机制 | daemon 检测到 host 在 thread 里的 @-mention，CLI 调对应成员 agent，再用成员 bot token 自己 POST 回复 | daemon 直接 CLI 调每位候选 agent（顺序 shuffle） |
| 收敛条件 | 主持人达到最大轮数 OR 信息充分 → `[END]` | 主持人覆盖所有专业角度 OR 总发言到上限 → `[END]` |
| 适合场景 | 评审、规划会等需要保证每人发言的讨论 | 头脑风暴、依靠各专业域自主介入的决策 |

### 主持人何时可以结束讨论？

主持人**在任何被调度到的时刻都可以输出 `[END]`**，不必等到 `maxRounds` 或 `maxMessages` 上限。每次调用都会把完整 transcript 喂给主持人 LLM，由它按 `SOUL.md` 决定输出收口结论 + `[END]` 还是继续推进。被调度的频率：

- **round-robin**：每次成员发言之后
- **free-speak**：每个轮询周期至少一次（主持人是队尾候选）

只有**主持人 bot 自己**输出的 `[END]` 才能结束 thread。真用户或其他 bot 在 thread 里输入 `[END]` 会被当作普通内容，不会触发结束。

---

## 前置条件

### OpenClaw 侧

- OpenClaw gateway 在跑（`openclaw channels status --probe` 能输出 channel 列表）
- 每个 agent 已创建在 `<openclawRoot>/<agent>/workspace/`
- 单 agent 能响应：`openclaw agent --agent <name> --message "test"` 返回有效结果

### 飞书侧

- N 个自建应用（每个 agent 一个，包括主持人）
- 每个应用都加入了对应的群作为机器人成员
- 各角色的 scope 已开通——详见 [docs/feishu-permissions.md](docs/feishu-permissions.md)
- **所有 bot 的 OpenClaw 飞书插件都必须 disabled**（v0.1.2 起 daemon 接管 dispatch）。daemon 启动时会硬检查这一点，任何一个没关都会拒绝起来。

### 运行环境

- Node.js ≥ 18
- `openclaw` CLI 在 `PATH` 上
- `jq`、`curl`

---

## 安装

```bash
git clone https://github.com/nativeProductor/openclaw-team-in-feishu.git
cd openclaw-team-in-feishu
npm install --no-audit --no-fund
sudo npm link --no-audit --no-fund
octf --help
```

（`--no-audit --no-fund` 跳过 npm registry 的审计步骤，国内网络环境下能快几十秒。装出来的功能完全一致。）

---

## 快速上手

```bash
# 1. 生成 config + SOUL 模板
mkdir -p /etc/octf && cd /etc/octf

# 交互式 Q&A：
octf init

# 或模板模式（多 agent 时更快）：
#   octf init --template > my-config.json
#   $EDITOR my-config.json     # 填 cli_xxx / oc_xxx / agent / member
#   octf init --from my-config.json

# 2. 编辑每个 SOUL，填业务人设和行为规则
$EDITOR souls/pm-host.md

# 3. 设秘钥（建议放 /etc/octf/secrets.env，chmod 600）
export PM_HOST_SECRET=...; export DEV_SECRET=...

# 4. 验证全链路 + 自动回填 open_id 到 SOUL roster + 把 souls 部署到 agent workspace
#    （一条命令做完）
octf link --apply

# 5. 启动 daemon
octf daemon start
```

在飞书群里 `@<主持人 bot> <你的议题>`，主持人会开启 thread 并驱动讨论到收敛。

### 把 team 绑到新群

`init` 之后再要新增一个群：

```bash
# 1. 把 host + members 都加进新群作为机器人成员
# 2. 用 chat add 绑定：
octf chat add \
  --chat oc_NEW_GROUP_ID \
  --mode round-robin \
  --host pm-host \
  --members dev,mkt-a,qa \
  --max-rounds 5

# 3. 解析新群的 open_id + 回填 SOUL roster + 部署 souls 到 workspace
octf link --apply

# 4. 重启 daemon 让新配置生效
octf daemon restart
```

解绑：`octf chat remove --chat oc_xxx`。查看：`octf chat list`。

---

## 测试

```bash
octf verify --chat <oc_xxx> --topic "烟测话题"
```

`verify` 用一个成员 bot 模拟用户触发讨论（不需要真用户 token），监听 thread，主持人输出 `[END]` 后 exit 0；超时 exit 1。

---

## 配置

```jsonc
{
  "version": 1,
  "openclawRoot": "/path/to/oc",
  "transcriptDir": "/path/to/oc/.shared",
  "polling": { "intervalMs": 2500, "openclawTimeoutSec": 180 },

  "apps": [
    { "appId": "cli_xxx",
      "appSecret": "${PM_HOST_SECRET}",
      "agent": "pm-host",
      "role": "产品",
      "botName": "ProductBot" }
  ],

  "chats": [
    { "name": "ProductReview",
      "chatId": "oc_xxx",
      "mode": "round-robin",
      "host": "pm-host",
      "members": ["dev", "mkt", "qa"],
      "modeOptions": { "maxRounds": 5, "endKeyword": "[END]" } }
  ]
}
```

完整带注释的例子：[examples/octf.example.json](examples/octf.example.json)。

---

## 命令速查

| 命令 | 用途 |
|---|---|
| `octf init` | 交互式生成 config + SOUL 模板 |
| `octf chat add\|remove\|list` | 绑定 / 解绑 / 列出 team 服务的飞书群 |
| `octf link [--apply]` | 验证全链路（auth / channels / membership / SOUL.md 存在性）。`--apply`：解析成员 open_id、回填到本地 `souls/<host>.md` 名册、并把 `souls/*.md` 部署到各 agent workspace |
| `octf daemon <start\|stop\|restart\|status\|logs>` | 运行 orchestrator |
| `octf verify --chat <oc_xxx>` | 端到端烟测 |
| `octf logs [--tail]` | tail daemon + openclaw 日志 |

---

## 文档

- [docs/deployment.md](docs/deployment.md) —— systemd / pm2 / Docker 生产部署
- [docs/upgrading.md](docs/upgrading.md) —— 版本升级迁移说明（拉新版本前先看这个）
- [docs/feishu-permissions.md](docs/feishu-permissions.md) —— 飞书 scope per role + 错误码 + 威胁模型
- [docs/developer-guide.md](docs/developer-guide.md) —— 架构、加新模式、调试指南

---

## 已知限制

- `maxRounds` 和 `maxMessages` 是软上限（LLM 自觉遵守，daemon 不强制截断）
- 每次 agent 调用注入完整 thread transcript 到 prompt——输入 token 随累计消息数 O(N²) 增长。默认 5×5=25 上限内毫无压力，超过就要注意成本
- 轮询周期 2.5s，用户 @ 到主持人开口典型 5–15s
- **跨群并行有边界**：不同 agent 跨群**并行**执行（daemon 按 chat 一个独立 async loop，瓶颈只是 OpenClaw gateway 的 LLM 并发）；**同一个 agent 同时被两个群叫**会被 per-agent mutex 串行化（防 OpenClaw session 上下文串扰）。结论：两个群的成员越重叠，越偏串行
- thread 只能由主持人 bot 输出 `[END]` 结束；真用户在 thread 内发消息无法打断讨论
- 加群 / 移除 chat / 换秘钥要 `octf daemon restart`（chats 和 env vars 在启动时载入）。**改 SOUL 不需要重启**——daemon 本身从不读 SOUL，每次调 agent 都是 `openclaw agent` 直接读最新 SOUL
- daemon 状态在进程内存，意外重启会丢消息去重表（最坏情况：某条边界消息被重复处理一次）

> **生产部署提示。** v0.1.2 起 daemon 接管所有 dispatch，daemon 挂了就没有任何 bot 会回复——务必用 systemd `Restart=always` 兜底，详见 [docs/deployment.md](docs/deployment.md)。

---

## License

MIT — 见 [LICENSE](LICENSE)。
