#!/usr/bin/env bash
# loop-tick.sh —— loop-orchestrator 的调度器中立入口
#
# 它就是一层薄壳：替任意调度器敲 `orchestrator.ts --tick`（单步幂等），
# 并把全量日志写进 night_run.log、只在"有进展/需关注"时往 stdout 输出一行摘要。
#
# 为什么这样设计：stdout 是通用契约——任何捕获脚本输出的调度器/agent
# （Hermes cron / OpenClaw / 系统 crontab / systemd timer）都能拿这行摘要去推送；
# 空 stdout = 本轮无事可报 = 静默。不绑任何单一 agent。
#
# 项目路径解析优先级（从高到低）：
#   1) 命令行第 1 个参数：loop-tick.sh /path/to/project
#   2) 环境变量 LOOP_PROJECT
#   3) 配置文件里的 LOOP_PROJECT（默认 ~/.config/loop-tick.conf）
set -uo pipefail

# 目标项目目录（orchestrator 往这里写产物 + git commit）
# ⚠️ 别填 loop 仓库自身，否则会把 scratch 产物 commit 进 loop 仓库。
PROJ="${1:-${LOOP_PROJECT:-}}"

# 配置文件（中立位置，任一 agent 读同一份）
[ -z "$PROJ" ] && [ -f "${LOOP_TICK_CONF:-$HOME/.config/loop-tick.conf}" ] \
  && source "${LOOP_TICK_CONF:-$HOME/.config/loop-tick.conf}" \
  && PROJ="${LOOP_PROJECT:-}" || true

if [ -z "$PROJ" ]; then
  echo "❌ loop-tick: 未指定目标项目。用法：loop-tick.sh /path/to/project，或设 LOOP_PROJECT，或在 ${LOOP_TICK_CONF:-~/.config/loop-tick.conf} 写 LOOP_PROJECT=..." >&2
  exit 2
fi

# orchestrator.ts + tsx 都在 loop 仓库内：按本脚本真实位置定位（readlink -f 穿透 symlink）
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
ORCH="${LOOP_ORCH:-$SCRIPT_DIR/../orchestrator.ts}"

# 用 loop 仓库本地的 tsx（它的 node_modules 在那）；找不到才回退 npx（需全局/远程）
if [ -x "$SCRIPT_DIR/../node_modules/.bin/tsx" ]; then
  RUN=("$SCRIPT_DIR/../node_modules/.bin/tsx")
else
  RUN=(npx tsx)
fi

cd "$PROJ" 2>/dev/null || { echo "❌ loop-tick: 目标目录不存在 $PROJ"; exit 1; }

LOG="night_run.log"

# 跑单步 tick：抓 "tick 结果: <kind>" 判定本轮 outcome。
# 注意：不 tee 进 night_run.log——orchestrator 的 log() 已自己 appendFileSync 写日志，
# 这里再 tee 会让每行重复一遍。wrapper 只 grep stdout 拿 outcome 行，日志由 orchestrator 独占。
# （崩溃信息也已在 night_run.log：main().catch 走 log() 记录，stderr 上的 SDK 噪音不是我们的日志。）
outcome_line=$("${RUN[@]}" "$ORCH" --cwd "$PROJ" --tick 2>&1 | grep -E 'tick 结果:' | tail -1 || true)
kind=$(echo "$outcome_line" | sed -E 's/.*tick 结果: ([a-z_]+).*/\1/')
[ -n "$kind" ] || kind="unknown"

# outcome → stdout（调度器拿这行去推送；空 = 静默）
case "$kind" in
  advanced)
    summary=$(grep -E '第.*轮结束' "$LOG" | tail -1 | sed -E 's/^\[[^]]*\] //')
    echo "✅ loop 推进 | ${summary:-本轮已完成并提交}"
    ;;
  terminated)
    summary=$(grep -E '✅ 全部完成|🛑 达到全程预算|疑假完成' "$LOG" | tail -1 | sed -E 's/^\[[^]]*\] //')
    echo "🏁 loop 终止 | ${summary:-已结束}"
    ;;
  blocked)
    echo "🚧 loop 任务阻塞 | 连续空转或 ctx 撑爆达上限，需人工介入"
    ;;
  session_dropped)
    echo "🧠 loop 撞上下文 | 已弃会话重试（未达上限，继续跑）"
    ;;
  stalled|already_running|already_terminated|stopped)
    : ;;  # 静默：空转 / 并发冲突 / 已结束 / 已停
  *)
    echo "ℹ️ loop tick=$kind | 详见 $PROJ/$LOG"
    ;;
esac
