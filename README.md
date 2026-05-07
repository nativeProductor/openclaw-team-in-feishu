# oc-feishu-link

> 让你已有的 N 个 OpenClaw 智能体在飞书群里**协作讨论**。两种模式开箱即用：**轮流发言**（host 按顺序点名）和**自由发言**（成员自主决定要不要插话）。

---

## 1. 这个项目是什么

你已经用 OpenClaw 做出了 N 个智能体（产品助理、研发助理、测试助理、市场助理 ……），每个 agent 自己都跑得通。`oc-feishu-link` 把它们接到一个或多个飞书群里，**让它们能在群里以自然对话方式讨论一个议题，最后由主持人 agent 收口出结论**。

**它不做的事**：
- 不替你创建 OpenClaw 智能体（用 OpenClaw 自己的 CLI）
- 不是通用的飞书 bot 框架
- 不替代 OpenClaw 自带的飞书插件（轮流发言模式还要靠它给成员自动回复）

---

## 2. 前置条件（开始之前必须备齐）

### 2.1 OpenClaw 侧

- [ ] **OpenClaw gateway 在跑**（systemd 或前台），`openclaw channels status --probe` 能输出 channel 列表
- [ ] **每个 agent 已经创建好**：`/path/to/oc/<agent>/workspace/SOUL.md` 等基础文件存在
- [ ] **手动测试每个 agent 都能响应**：
  ```bash
  openclaw agent --agent pm-host --message "请说一句你好" --json
  # 期望返回 status=ok + 一段文本
  ```

### 2.2 飞书侧

- [ ] **N 个自建应用**（每个 agent 一个，1:1），已在飞书开发者后台创建并发版
- [ ] **每个应用都加入了对应的群**作为机器人成员
- [ ] **Scopes 已开通**（详见 [docs/feishu-permissions.md](docs/feishu-permissions.md)）：
  - 主持人 bot：`im:message.group_at_msg:readonly` + `im:chat.members:read` + `im:message:send_as_bot`
  - 成员 bot：`im:message.group_msg`（事件订阅，必须！）+ `im:message:send_as_bot`
- [ ] **OpenClaw 飞书插件状态正确配置**：
  - 主持人 bot：**禁用** native lark plugin（`openclaw config set channels.feishu.accounts.bot-<hostAppId>.enabled false`）
  - 成员 bot：**启用**（成员自动回复 @ 事件依赖它）
  - daemon 启动时会硬检查这一点；状态错就拒绝启动

### 2.3 运行环境

- [ ] **Node.js ≥ 18**（用了原生 fetch、execFileSync）
- [ ] **`jq`** 和 **`curl`**（脚本和文档示例用到）
- [ ] **服务器上能执行 `openclaw` CLI**（plugin 通过 `execFileSync("openclaw", [...])` 调用 agent）

> ⚠️ **如果上面任何一项没满足，先去满足它再回来。** 这个插件不解决"OpenClaw 自己的问题"或"飞书 app 还没创建"——它只解决"已有的这两套东西怎么对接"。

---

## 3. 实现原理（一图看懂）

```
                    ┌──────────────────────────────────────┐
                    │  飞书 OpenAPI（open.feishu.cn）       │
                    └────────▲────────────────▲────────────┘
              poll 主聊天     │                │ 发回复
              （检测 @host）   │                │ （reply_in_thread:true）
                              │                │
              ┌───────────────┴────────────────┴───────────┐
              │  oc-feishu-link daemon                     │
              │  （单进程，每个群一个独立 async loop）       │
              │                                             │
              │  state[chatId].threads[tid] 内存状态         │
              │  per-chat 串行；多群并发                      │
              └────────▲────────────────────┬───────────────┘
                       │                    │ execFileSync
            transcript │                    │ "openclaw agent
            （chat-id +│                    │  --agent <X>
            thread-id  │                    │  --message <prompt>"
            双写）     │                    │
                       │                    ▼
            ┌──────────┴───────┐   ┌──────────────────────────┐
            │  /shared/        │   │  OpenClaw gateway         │
            │  transcript-*.md │   │  （单进程，单 LLM 队列）    │
            └────────▲─────────┘   │                            │
                     │             │  每 agent 的 SOUL.md       │
                     │ cat（每个   │  native lark plugin：       │
                     │ agent 回复  │   - host: 必须 DISABLED    │
                     │ 前都读它）  │   - member: 必须 ENABLED   │
                     └─────────────┤                            │
                                   └──────────────────────────┬─┘
                                                              │
                              （仅 round-robin 模式）         │ 成员被 @
                                                              │ 时 native
                                                              │ 自动 dispatch
                                                              ▼
                                                    成员发言 → 入 thread
```

### 三个核心契约

1. **讨论规则在 SOUL.md 里，不在 daemon。** maxRounds、谁先发言、何时 [END]、何时 [SKIP] —— 全部由各 agent 的 LLM 看 SOUL.md 自觉遵守。daemon 只负责机制：轮询 / 写 transcript / fork openclaw / 发回复。
2. **主持人 native 插件必须禁用，成员必须启用。** 否则 host 双发言 → 双 thread → daemon 永远 poll 错的那个 → 死锁。daemon 启动 preflight 硬检查这一点。
3. **transcript 是唯一 ground truth。** daemon 和 agent 都从同一份 markdown 文件里读状态。每条消息追加 + 双写（按 thread_id 给 daemon 自己用，按 chat_id 给 SOUL.md 里的 `cat` 路径用）。

### 两种模式的实现差异

**round-robin（轮流发言）**
- host 在每条消息里 @-mention 下一位成员
- 成员的 OpenClaw native lark 插件收到 @ 事件自动跑 agent → 自动回复
- 成员回复后 daemon 检测到新消息 → 调 host → host 再 @ 下一位
- host 决定何时输出 `[END]`（看自己 SOUL.md 里的 maxRounds）

**free-speak（自由发言）**
- host 开场**不 @ 任何人**，只说"现在自由发言"
- daemon 在 thread 出现新消息后**主动逐个询问**所有成员 + host："看了 transcript，你要不要插话？不插就只输出 `[SKIP]`"
- 谁第一个返回非 `[SKIP]` 内容就由 daemon 用其 app token 发到群里
- host 也按同样机制被询问；它判断讨论收敛了就输出 `[END]`

两种模式共用一套 daemon、一套触发机制、一套 transcript 系统；只在"成员怎么被触发"这一点上分叉。

---

## 4. 部署（5 条命令到第一次讨论）

最简形态。生产环境配 systemd / pm2 / Docker 见 **[docs/deployment.md](docs/deployment.md)**。

```bash
# 1. 安装。当前 v0.1 还没发 npm registry，从 GitHub clone + npm link：
git clone https://github.com/nativeProductor/openclaw-team-in-feishu.git
cd openclaw-team-in-feishu && npm install && sudo npm link
oc-feishu-link --help    # 验证

# 2. 交互式生成 config + SOUL 模板（必须在交互终端，piped stdin 不行）
oc-feishu-link init
# → ./oc-feishu-link.json
# → ./souls/<agent>.md  （每个 agent 一份，含占位符）

# 3. 编辑 souls/<agent>.md 填入业务人设。
#    模板里明确标注了哪些段必须保留、哪些段你来填。
$EDITOR souls/pm-host.md

# 4. 把秘钥放到环境变量（config 里 ${VAR} 引用），然后 link 验证
export PM_HOST_SECRET=...; export DEV_SECRET=...; export QA_SECRET=...
oc-feishu-link link
# 期望输出：n pass, 0 warn, 0 fail
# 任何 ✗ 必须先修

# 5. 把 souls 拷贝到 agent workspace（手动一步：给你 review 的机会）
cp souls/pm-host.md /path/to/oc/pm-host/workspace/SOUL.md
cp souls/dev.md     /path/to/oc/dev/workspace/SOUL.md
# ... 每个 agent 一遍

# 6. 启动 daemon（前台；生产用 systemd 见 docs/deployment.md）
oc-feishu-link daemon start
```

启动完毕后，在飞书群里 `@<host_bot_name> 启动需求评审：<你的议题>` 就能触发讨论。

### 不进飞书 UI 的端到端烟测

```bash
oc-feishu-link verify --chat oc_xxx --topic "插件烟测"
# 自动用一个成员 bot 模拟用户 @ host，然后等 host 输出 [END]
# 600 秒超时；通过则 exit 0 + 打印 "✓ END detected after Ns"
```

`verify` 是验收一个新部署是否真的端到端通的最佳工具。

---

## 5. 命令速查

| 命令 | 何时用 |
|---|---|
| `init` | 第一次安装，scaffold config + souls |
| `link` | 改完 config 或 souls 之后，跑这个验证全链路 |
| `daemon start` | 启动 orchestrator（前台） |
| `daemon status / stop / restart / logs` | 配合 systemd 单元用 |
| `verify --chat <oc_xxx>` | 端到端烟测 |
| `logs [--tail]` | 关联看 daemon 日志 + openclaw runtime 日志 |

---

## 6. 配置 schema（精简版，全字段见 [examples/](examples/oc-feishu-link.example.json)）

```jsonc
{
  "version": 1,
  "openclawRoot": "/path/to/oc",            // 必填
  "transcriptDir": "/path/to/oc/.shared",   // default: <openclawRoot>/.shared
  "polling": { "intervalMs": 2500, "openclawTimeoutSec": 180 },

  "apps": [
    // 每个 Feishu bot ↔ 一个 openclaw agent，1:1
    { "appId": "cli_xxx",
      "appSecret": "${PM_HOST_SECRET}",     // ${VAR} 从 process.env 取
      "agent": "pm-host",                   // 必须存在 <openclawRoot>/<agent>
      "role": "产品助理",                    // transcript & SOUL 里的展示标签
      "botName": "OpenClaw-PM" }            // 飞书里 bot 的显示名
    // ... 其他 app
  ],

  "chats": [
    { "name": "ProductReview",              // 自由命名，仅日志显示
      "chatId": "oc_xxx",
      "mode": "round-robin",                // "round-robin" | "free-speak"
      "host": "pm-host",                    // 引用 apps[].agent
      "members": ["dev", "mkt-a", "qa"],
      "modeOptions": {
        "maxRounds": 5,                     // round-robin 专属（软上限，看 SOUL）
        "maxMessages": 25,                  // free-speak 专属
        "endKeyword": "[END]"
      } }
  ]
}
```

---

## 7. 已知边界与限制

- `maxRounds` / `maxMessages` 是**软**上限——通过 SOUL.md 告诉 LLM，靠 LLM 自觉遵守；daemon 不强制截断
- daemon 状态全在内存：进程重启会丢去重表（旧消息可能被重新 ingest 一遍）
- LLM 输入 token 是 `O(N²)`：每次 invoke 都注入完整 transcript；50+ 条讨论时变 cost 主导
- polling 延迟 2.5s × LLM 时间，用户 @ host 到主持人开口典型 5-15s
- 单 OpenClaw gateway = 单 LLM 队列；多群并发 = 排队
- free-speak 在大量 [SKIP] 时收敛较慢（典型 10-15 分钟），round-robin 通常 5-7 分钟

详细架构 review 和 v0.2 路线图见 [docs/developer-guide.md](docs/developer-guide.md)。

---

## 8. 文档索引

- 📦 [docs/deployment.md](docs/deployment.md) —— systemd / pm2 / Docker 部署、day-2 ops、上线 checklist
- 🔐 [docs/feishu-permissions.md](docs/feishu-permissions.md) —— 飞书 scope per role 表 + native 插件 enable/disable + 错误码字典
- 🛠️ [docs/developer-guide.md](docs/developer-guide.md) —— 架构图、加新模式、SOUL 模板变量、调试故障树
- 📋 [examples/oc-feishu-link.example.json](examples/oc-feishu-link.example.json) —— 完整可参考的 8-bot/2-group 配置
- 🧰 [examples/oc-feishu-link.service](examples/oc-feishu-link.service) —— systemd 单元模板（含硬化项）

## License

MIT
