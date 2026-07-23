# loop-scheduler skill

把 loop-orchestrator（`orchestrator.ts`）接成定时任务的胶水。**调度器中立**——同一份 wrapper，Hermes cron / OpenClaw / 系统 crontab / systemd timer 都能驱动。orchestrator 本身一个字不改。

## 核心契约

orchestrator 暴露幂等单步接口 `orchestrator.ts --tick`（取一个未完成任务 → 执行 → 打勾/commit → 退出）。wrapper `loop-tick.sh` 做两件事：

1. 替调度器敲这条命令（orchestrator.ts 依赖 loop 仓库 node_modules，不能搬走，用 symlink 就位）。
2. **把全量日志写进 `night_run.log`，只在「有进展/需关注」时往 stdout 输出一行摘要。** stdout 是通用契约：任何捕获脚本输出的调度器都拿它去推送；空 stdout = 静默。不绑任何单一 agent。

## 文件

| 文件 | 作用 |
|---|---|
| `SKILL.md` | skill 说明（agent 读它执行安装/操作） |
| `loop-tick.sh` | wrapper 本体（替调度器敲 `--tick` + outcome→stdout 映射） |
| `loop-tick.conf.example` | 目标项目配置模板（拷成 `~/.config/loop-tick.conf`） |

## 安装（通用三步）

```bash
# 1. wrapper 就位（symlink 进 PATH，本体留仓库跟版本走）
ln -sf /path/to/loop/skill/loop-tick.sh /usr/local/bin/loop-tick
chmod +x /path/to/loop/skill/loop-tick.sh
cp /path/to/loop/skill/loop-tick.conf.example ~/.config/loop-tick.conf
# 编辑 ~/.config/loop-tick.conf 填 LOOP_PROJECT=<你的目标项目>

# 2. 验证能单步跑通
loop-tick

# 3. 接你的调度器（三选一，wrapper/orchestrator 都不改）
# 系统 crontab:   */5 * * * * loop-tick >> /var/log/loop-tick.log 2>&1
# Hermes cron:    hermes cron create 'every 5m' --no-agent --script loop-tick.sh --deliver wecom
#                 （Hermes 需额外: ln -sf .../loop-tick.sh ~/.hermes/scripts/loop-tick.sh；gateway 先跑）
# OpenClaw/其他:   当一条可定时执行的命令调即可
```

## outcome → stdout

| kind | 推送 |
|---|---|
| advanced | ✅ 推进摘要 |
| terminated | 🏁 终止原因 |
| blocked | 🚧 需人工介入 |
| session_dropped | 🧠 撞上下文继续跑 |
| stalled / already_running / already_terminated / stopped | 静默 |

## 为什么是 wrapper 而不是直接调 orchestrator

`hermes cron --script` 等调度器要的是「一个文件」或「一条命令」，且 orchestrator.ts 依赖 loop 仓库的 `node_modules` 不能搬走。wrapper 就是那个快捷方式——存一行命令成文件、放调度器要的位置、顺带把 stdout 约束成「只推摘要」，所以任何调度器都能用同一份。
