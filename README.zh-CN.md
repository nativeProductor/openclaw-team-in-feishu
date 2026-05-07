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
- 不替代 OpenClaw 的飞书插件（轮流发言模式下成员自动回复仍依赖它）
- 不是通用的飞书 bot 框架

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
              │  （单进程，每个群一个独立 async loop）         │
              └────────▲────────────────────┬────────────────┘
                       │                    │ execFileSync
            transcript │                    │ "openclaw agent
            (thread-id │                    │  --agent X
            + chat-id  │                    │  --message <prompt>"
             双写)     │                    ▼
            ┌──────────┴───────┐   ┌──────────────────────┐
            │ /shared/         │   │  openclaw gateway    │
            │ transcript-*.md  │   │  每 agent 的 SOUL    │
            └────────▲─────────┘   │  飞书插件 enable：    │
                     │             │   host    DISABLED   │
                     │ 各 agent    │   members ENABLED    │
                     │ 回复前 cat  │                      │
                     │             └──────────┬───────────┘
                     │                        │ 成员被 @ 时插件自动 dispatch
                     │                        │（仅 round-robin 模式）
                     │                        ▼
                     └─────────────── 回复进入 thread
```

### 三个核心契约

1. **讨论规则在 `SOUL.md` 里，不在 daemon。** 发言顺序、最大轮数、何时输出 `[END]`、何时输出 `[SKIP]` —— 全部由各 agent 的 LLM 看 `SOUL.md` 自觉遵守。daemon 只做机制：轮询、写 transcript、fork openclaw、发回复。换讨论形式（debate / review / brainstorm）只改 SOUL.md，daemon 一行不动。
2. **主持人 bot 的 OpenClaw 飞书插件必须 disabled，成员 bot 必须 enabled。** 两边都 enabled 会让主持人双发言、生成重复 thread、daemon 死锁。daemon 启动时硬检查这一点。
3. **transcript 文件是唯一 ground truth。** daemon 和 agent 都从同一份 Markdown 文件读状态。每条消息追加一次，分别按 `<thread_id>.md`（daemon 内部用）和 `<chat_id>.md`（SOUL.md 里 `cat` 路径用）双写。

### 两种模式对比

| | round-robin（轮流发言） | free-speak（自由发言） |
|---|---|---|
| 谁决定下一个发言 | 主持人按 SOUL.md 顺序 @ 下一位 | daemon 用 `[SKIP]` 选项轮询每位 agent，agent 自决 |
| 成员触发机制 | OpenClaw 飞书插件收到 @ 自动 dispatch | daemon 直接通过 openclaw CLI 调用 |
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
- 每个群：主持人 bot 的 OpenClaw 飞书插件 disabled，成员 bot enabled

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

# 4. 验证全链路 + 自动回填 open_id 到 SOUL roster
octf link --apply

# 5. SOUL 拷贝到 agent workspace
for a in pm-host dev mkt-a qa; do
  cp souls/$a.md /path/to/oc/$a/workspace/SOUL.md
done

# 6. 启动 daemon
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

# 3. 解析新群的 open_id + 回填 SOUL roster
octf link --apply

# 4. 如果 host/member 在新群里是首次出现，需要把新生成的 souls 拷到 agent workspace
# 5. 重启 daemon
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
| `octf link [--apply]` | 验证全链路；`--apply` 自动把成员 bot 的 renderMode 设为 raw 并把 open_id 回填到 SOUL roster |
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
- daemon 状态全在进程内存，重启会丢去重表
- 每次 agent 调用注入完整 transcript（输入 token 随累计消息数增长）
- 轮询周期 2.5s，用户 @ 到主持人开口典型 5–15s
- 单 OpenClaw gateway = 单 LLM 队列，多群并发会排队
- thread 只能由主持人 bot 输出 `[END]` 结束；真用户在 thread 内发消息无法打断讨论
- 新增/移除 chat 后需要重启 daemon（配置只在启动时读一次）

---

## License

MIT — 见 [LICENSE](LICENSE)。
