#!/usr/bin/env bash
# loop-orchestrator 安装 / 卸载 / 重装脚本 —— agent 无关
#
#   安装：  curl -fsSL https://raw.githubusercontent.com/free-wyq/loop/main/install.sh | bash
#   卸载：  curl -fsSL https://raw.githubusercontent.com/free-wyq/loop/main/install.sh | bash -s -- uninstall
#           （已装好则直接：bash ~/.local/share/loop/install.sh uninstall）
#   重装：  ... | bash -s -- reinstall    （= 干净卸载后全新安装，解决 node_modules 脏 / 代码树卡住）
#   升级：  重跑安装命令即可（增量：git pull + npm install，保留你的本地改动与配置）
#
# 装到 POSIX 中立路径（不进任何 agent 私有目录）：
#   代码  ~/.local/share/loop
#   命令  ~/.local/bin/loop        (自驱入口，透传参数给 orchestrator.ts)
#         ~/.local/bin/loop-tick   (定时器 wrapper，symlink)
#   配置  ~/.config/loop-tick.conf
set -euo pipefail

REPO_URL="https://github.com/free-wyq/loop.git"
DEST="${LOOP_HOME:-$HOME/.local/share/loop}"
BIN_DIR="${LOOP_BIN:-$HOME/.local/bin}"
CONF_DIR="${LOOP_CONF:-$HOME/.config}"
CONF_FILE="$CONF_DIR/loop-tick.conf"

# 已知 agent 的 skills 目录 —— 卸载时扫这里的 loop-scheduler symlink（指向我们或已悬空）清掉
AGENT_SKILL_DIRS=(
  "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.gemini/skills"
  "$HOME/.cursor/skills" "$HOME/.codeium/skills" "$HOME/.windsurf/skills"
  "$HOME/.hermes/skills"
)

say()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }

# 写文件前防覆盖：已存在且非 symlink 且内容不同 → 备份成 .bak，绝不静默覆盖
safe_write() {  # safe_write <path> <content>
  local f="$1"
  if [ -e "$f" ] && [ ! -L "$f" ]; then
    if [ "$2" = "$(cat "$f" 2>/dev/null)" ]; then return; fi  # 内容一致=我们的
    mv "$f" "$f.bak" 2>/dev/null || true
    warn "已有 $f，已备份为 $f.bak（原内容未丢）"
  fi
  printf '%s' "$2" > "$f"
}

# 备份并删除用户数据文件（conf 等），保留 .bak 以防误删
backup_rm() {  # backup_rm <path>
  if [ -e "$1" ] || [ -L "$1" ]; then
    mv "$1" "$1.bak" 2>/dev/null || rm -f "$1"
    say "已备份 $1 → $1.bak"
  fi
}

check_node() {
  command -v node >/dev/null 2>&1 || { err "未检测到 Node。请先装 Node 18+（https://nodejs.org）再重跑。"; exit 1; }
  local major; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 18 ] || { err "Node 版本过低（$(node -v)，需 18+），请升级后重跑。"; exit 1; }
}

do_install() {
  check_node
  mkdir -p "$BIN_DIR" "$CONF_DIR"

  # 1. 拉代码（已有则增量更新，不覆盖本地改动）
  if [ -d "$DEST/.git" ]; then
    say "已存在，更新中：$DEST"
    git -C "$DEST" pull --ff-only || { err "git pull 失败（可能有未提交改动）。手动处理 $DEST，或用 reinstall 干净重装。"; exit 1; }
  else
    if [ -d "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
      err "$DEST 非空且非 git 仓库，请移走后重跑，或用 uninstall 清理。"
      exit 1
    fi
    say "拉取代码到 $DEST"
    git clone --depth 1 "$REPO_URL" "$DEST"
  fi

  # 2. 装依赖
  say "安装依赖（npm install）"
  npm install --prefix "$DEST" --silent

  # 3. 装 loop 命令（路径已固化进脚本，readlink 自定位无关，换机器照样跑）
  say "安装 loop 命令到 $BIN_DIR"
  safe_write "$BIN_DIR/loop" '#!/usr/bin/env bash
# loop —— loop-orchestrator 入口，透传所有参数给 orchestrator.ts
exec "'"$DEST"'/node_modules/.bin/tsx" "'"$DEST"'/orchestrator.ts" "$@"
'
  chmod +x "$BIN_DIR/loop"

  # 4. 装 loop-tick wrapper（symlink，指向仓库内 skill/loop-tick.sh）
  say "安装 loop-tick wrapper 到 $BIN_DIR"
  if [ -e "$BIN_DIR/loop-tick" ] && [ "$(readlink "$BIN_DIR/loop-tick" 2>/dev/null)" != "$DEST/skill/loop-tick.sh" ]; then
    mv "$BIN_DIR/loop-tick" "$BIN_DIR/loop-tick.bak" 2>/dev/null || true
    warn "已有 loop-tick，已备份为 loop-tick.bak"
  fi
  ln -sfn "$DEST/skill/loop-tick.sh" "$BIN_DIR/loop-tick"
  chmod +x "$DEST/skill/loop-tick.sh"
  [ -f "$CONF_FILE" ] || cp "$DEST/skill/loop-tick.conf.example" "$CONF_FILE"

  # 5. PATH 检查（不替用户改 shell rc，只提示）
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR 不在 PATH。请加一行到 shell 配置：export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac

  echo
  say "安装完成！"
  echo
  echo "  装在：$DEST（代码）  $BIN_DIR/loop（命令）"
  echo
  echo "  直接跑：    loop --cwd /path/to/your/project \"你的开发目标\""
  echo "  看状态：    loop --cwd /path/to/your/project --status"
  echo "  接定时器：  loop-tick /path/to/your/project"
  echo
  echo "  注册 skill（可选，本脚本不替你做，用 symlink 不复制）："
  echo "    ln -sf $DEST/skill ~/.claude/skills/loop-scheduler     # Claude Code"
  echo "    ln -sf $DEST/skill ~/.codex/skills/loop-scheduler      # Codex"
  echo "    ln -sf $DEST/skill ~/.gemini/skills/loop-scheduler     # Gemini CLI"
  echo
  echo "  ⚠️ --cwd 指向你要开发的目标项目，别指向 loop 仓库自身。"
  echo "  卸载：bash $DEST/install.sh uninstall"
}

do_uninstall() {
  local removed=0

  # 1. 清两个命令文件（含遗留 .bak 一起清）
  for f in "$BIN_DIR/loop" "$BIN_DIR/loop-tick"; do
    if [ -e "$f" ] || [ -L "$f" ]; then rm -f "$f" "$f.bak"; removed=1; fi
  done

  # 2. 配置文件是用户数据 → 备份再删（误卸能恢复）
  if [ -e "$CONF_FILE" ]; then
    mv "$CONF_FILE" "$CONF_FILE.bak" 2>/dev/null || rm -f "$CONF_FILE"
    say "配置已备份 → $CONF_FILE.bak"
    removed=1
  fi

  # 3. 清各 agent skills 目录里的 loop-scheduler symlink
  #    （只清指向我们 DEST、或因 DEST 已删而悬空的；指向别处的不动）
  for d in "${AGENT_SKILL_DIRS[@]}"; do
    local lk="$d/loop-scheduler"
    if [ -L "$lk" ]; then
      local tgt; tgt="$(readlink "$lk" 2>/dev/null || true)"
      case "$tgt" in
        "$DEST/skill"|"$DEST"/*) rm -f "$lk"; say "清 skill symlink：$lk"; removed=1 ;;
        *) # 悬空链接（目标已不存在）也清
          [ -e "$tgt" ] || { rm -f "$lk"; say "清悬空 skill symlink：$lk"; removed=1; } ;;
      esac
    fi
  done

  # 4. 删代码目录（最后删，保证上面的 symlink 悬空检测先跑）
  if [ -d "$DEST" ]; then rm -rf "$DEST"; removed=1; fi

  if [ "$removed" = 1 ]; then
    echo
    say "已卸载 loop-orchestrator（代码/命令/skill symlink 已清，配置留 .bak 备份）"
  else
    warn "未检测到 loop-orchestrator 的安装痕迹，无需卸载"
  fi
}

do_reinstall() {
  say "重装 = 干净卸载 + 全新安装"
  do_uninstall
  echo
  do_install
}

case "${1:-install}" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
  reinstall) do_reinstall ;;
  -h|--help|help)
    sed -n '2,12p' "$0" ;;
  *) err "未知子命令：$1（可用：install / uninstall / reinstall）"; exit 2 ;;
esac
