---
name: loop-scheduler
description: "把 loop-orchestrator（基于 claude-agent-sdk 的 24h 无人值守开发 orchestrator）接成定时任务。用幂等单步 tick + stdout 摘要契约，任意调度器/agent（Hermes cron / OpenClaw / 系统 crontab / systemd）都能驱动，有进展才推送、空转静默。"
version: 1.1.0
author: free-wyq
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [automation, scheduler, unattended, orchestrator, claude-agent-sdk]
    related_skills: [claude-code]
---

# Loop Scheduler

把 loop-orchestrator（`orchestrator.ts`，用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 写的 24h 无人值守开发 orchestrator）接成定时任务。**调度器中立**——同一份 wrapper，Hermes cron / OpenClaw / 系统 crontab / systemd timer 都能驱动。

## 核心契约：tick + stdout 摘要

orchestrator 暴露的唯一接口是幂等单步 `orchestrator.ts --tick`：取一个未完成任务 → 执行 → 打勾/commit → 退出。wrapper `loop-tick.sh` 做两件事：

1. 替调度器敲这条命令（orchestrator.ts 依赖 loop 仓库的 `node_modules`，不能搬走，所以用 wrapper + symlink）。
2. **把全量日志写进 `night_run.log`，只在「有进展/需关注」时往 stdout 输出一行摘要。** 这是通用契约：任何捕获脚本输出的调度器都拿这行摘要去推送；空 stdout = 静默。不绑任何单一 agent。

## tick outcome → stdout（通用推送策略）

| kind | 含义 | stdout |
|---|---|---|
| `advanced` | 有真改动并 commit | `✅ loop 推进 | <摘要>` |
| `terminated` | done / 预算耗尽 / 疑假完成 | `🏁 loop 终止 | <原因>` |
| `blocked` | 连续 3 次空转或 ctx 撑爆达上限 | `🚧 需人工介入` |
| `session_dropped` | 撞上下文已弃会话重试（未达上限） | `🧠 继续跑` |
| `stalled` / `already_running` / `already_terminated` / `stopped` | 空转 / 并发冲突 / 已结束 / 已停 | 空（静默） |

原则：**只在状态变化或需人工介入时输出**。正常推进（advanced）可选推或不推——嫌吵在 wrapper 里把它改静默，只推 terminated/blocked。

## 安装

**推荐：一条命令（装好 `loop`/`loop-tick` 到 `~/.local/bin`，自动配 wrapper + conf）**

```bash
curl -fsSL https://raw.githubusercontent.com/free-wyq/loop/main/install.sh | bash
```

下面是手动装 wrapper 的方式（已有 loop 仓库源码、不想用 install.sh 时）：

### 1. wrapper 就位 + 配目标项目

```bash
mkdir -p ~/.config
ln -sf /path/to/loop/skill/loop-tick.sh /usr/local/bin/loop-tick   # 或 ~/bin，加进 PATH
chmod +x /path/to/loop/skill/loop-tick.sh

# 配置目标项目（三种方式任选其一）
#   a) 命令行参数：loop-tick /path/to/project
#   b) 环境变量：export LOOP_PROJECT=/path/to/project
#   c) 配置文件（推荐，多调度器读同一份）：
cp /path/to/loop/skill/loop-tick.conf.example ~/.config/loop-tick.conf
# 编辑 ~/.config/loop-tick.conf 填 LOOP_PROJECT=/home/wyq/work/project/你的目标项目
```

⚠️ **目标项目绝不能是 loop 仓库自身**——会把 scratch 产物 commit 进 loop 仓库污染历史。

### 2. 验证能单步跑通

```bash
loop-tick   # 手动跑一次
```

期望：进目标项目、调 `loop --tick`（或 `orchestrator.ts --tick`）、stdout 输出一行 `✅/🏁/🚧/🧠` 摘要或空。看 `night_run.log` 里有 `tick 结果: <kind>`。

### 3. 接到你的调度器

wrapper 是标准命令，接哪个调度器写哪个的胶水，**orchestrator 和 wrapper 都不改**：

```bash
# —— 系统 crontab（每 5 分钟，stdout 进 cron 邮件或日志）——
*/5 * * * * loop-tick >> /var/log/loop-tick.log 2>&1

# —— systemd timer（每 5 分钟，systemd 接管 stdout/journal）——
# [loop-tick.service] ExecStart=loop-tick
# [loop-tick.timer] OnCalendar=*:0/5

# —— Hermes cron（stdout 原样推送到 --deliver 频道）——
# 需先 hermes cron status 绿，没跑就 hermes gateway install
hermes cron create 'every 5m' --no-agent --name loop-tick \
  --script loop-tick.sh --deliver wecom
# 注意 hermes 硬要求 --script 在 ~/.hermes/scripts/ 下，所以 Hermes 专用：
ln -sf /path/to/loop/skill/loop-tick.sh ~/.hermes/scripts/loop-tick.sh

# —— OpenClaw 或其他 agent：把它当一条可定时执行的命令调即可 ——
```

## 注册成当前 agent 的 skill（可选）

多数 agent 的 skill 扫描器用 find/glob 遍历 skills 目录，**默认不跟符号链接进子目录**——symlink 一个 skill 目录进去，扫描器看不见它（实测 `find <skills>/loop-scheduler -name SKILL.md` 对 symlink 返回空、对真目录正常）。所以要拷成真目录：

```bash
# 1. 推理你 agent 的 skills 目录（常见位置，按实际判断；不确定就查该 agent 文档）：
#    Claude Code ~/.claude/skills · Codex ~/.codex/skills · Gemini CLI ~/.gemini/skills
#    Cursor ~/.cursor/skills · Hermes ~/.hermes/skills
SKILLS_DIR=~/.claude/skills

# 2. 拷成真目录（loop 升级后重跑这两行刷新 skill 内容）
mkdir -p "$SKILLS_DIR"
rm -rf "$SKILLS_DIR/loop-scheduler"
cp -r /path/to/loop/skill "$SKILLS_DIR/loop-scheduler"

# 3. 验证扫描器能看到：find "$SKILLS_DIR/loop-scheduler" -name SKILL.md 应返回一行
```

## 日常操作（对 orchestrator，调度器无关）

| 操作 | 命令 |
|---|---|
| 实时状态 | `loop --cwd <proj> --status` |
| 运行报告 | `loop --cwd <proj> --report` |
| 临时停 | `loop --cwd <proj> --stop`（写 .stop 哨兵；下次 tick 自动 stopped） |
| 恢复 | `loop --cwd <proj> --resume`（删 .stop） |
| 改间隔 | 改你那个调度器的 schedule（cron/edit timer/hermes cron edit），不动 wrapper |

## 密钥 / 限额配置

调度器跑干净 env 不 source `~/.bashrc`，密钥得写进 `~/.config/loop.env`（orchestrator 启动自动读，已 export 的不覆盖）：

```bash
cp ~/.local/share/loop/loop.env.example ~/.config/loop.env && chmod 600 ~/.config/loop.env
# 填 ANTHROPIC_API_KEY=sk-...；走代理加 ANTHROPIC_BASE_URL=http://...:3000、ANTHROPIC_MODEL=glm-5.1
```

限额默认全 `0 = 不限`（自托管/免费代理模型没有按量计费，预算护栏纯属挡路，实测 GLM 代理单任务 $3/bootstrap $1 都不够会崩）。要护栏再设正数：`LOOP_MAX_TURNS`/`LOOP_MAX_BUDGET_PER_TASK`/`LOOP_MAX_BUDGET_TOTAL`/`LOOP_BOOTSTRAP_MAX_TURNS`/`LOOP_BOOTSTRAP_MAX_BUDGET`/`LOOP_STALL_LIMIT`/`LOOP_ABORT_TIMEOUT_MIN`/`LOOP_SESSION_RETRY_LIMIT`。详见 [install.md](../install.md)。

## 崩溃恢复（自动，无需人工）

每次跑的是幂等 `--tick`。某 tick 被杀（重启 / gateway 挂 / kill -9）：
- `state.json` 原子写未截断；成本在「阶段A」已落盘（不丢钱）
- `events.jsonl` 里该 `tick_started` 无配对 `tick_completed` = 崩溃
- 进程级锁 `.tick.lock` 60s 后 stale 自动 takeover
- 下个 tick 从崩溃处续跑同任务，`loop_count` 不丢、不重复打勾

**所以调度器临时挂了不用管**，重启后自动接着跑，不用重新 bootstrap。

## 已知坑

1. **`orchestrator.ts` 不能搬走**——依赖 loop 仓库的 `node_modules`，所以 wrapper 用 symlink 就位、本体留仓库跟版本走。
2. **目标项目绝不能是 loop 仓库自身**——会污染 git 历史。
3. **stdout 策略是 wrapper 的核心**——全量日志进 `night_run.log`，stdout 只留摘要，否则高频调度下推送频道被刷屏。
4. **改目标项目改 `~/.config/loop-tick.conf` 的 `LOOP_PROJECT`**，别改 wrapper 本体。
5. **Hermes 特例**：`--script` 硬要求 `~/.hermes/scripts/` 下，需额外 symlink（见步骤 3）。
6. **Hermes 特例**：Gateway 不跑则 cron 永不触发，`hermes cron status` 必须先绿。
