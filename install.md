# loop-orchestrator 安装（给 AI 助手读）

> 这是一段给 AI 助手执行的安装指令。读取本文档即感知操作流程，按当前环境自行执行，不要反复询问用户。

## 一条命令装好

```bash
curl -fsSL https://raw.githubusercontent.com/free-wyq/loop/main/install.sh | bash
```

装到中立路径（不碰任何 agent 私有目录）：代码 `~/.local/share/loop`、命令 `~/.local/bin/loop`、配置 `~/.config/loop-tick.conf`。已有同名文件自动备份成 `.bak`，不静默覆盖。不改 shell rc（PATH 不在 `~/.local/bin` 会提示加一行）。

装完即用：

```bash
loop --cwd /path/to/your/project "你的开发目标"   # 自驱：拆任务 → 自动推进 → 自动 commit
loop --cwd /path/to/your/project --status        # 实时状态
loop-tick /path/to/your/project                  # 单步（给定时器/agent 调度）
```

## 卸载 / 重装 / 升级

```bash
# 卸载（代码/命令/skill symlink 全清，配置留 .bak 备份可恢复）
curl -fsSL https://raw.githubusercontent.com/free-wyq/loop/main/install.sh | bash -s -- uninstall
# 已装好可直接：bash ~/.local/share/loop/install.sh uninstall

# 重装（= 干净卸载 + 全新安装，解决 node_modules 脏 / 代码树卡住）
curl -fsSL https://raw.githubusercontent.com/free-wyq/loop/main/install.sh | bash -s -- reinstall

# 升级（重跑安装命令即可，增量更新，保留本地改动与配置）
curl -fsSL https://raw.githubusercontent.com/free-wyq/loop/main/install.sh | bash
```

## 前提

- Node 18+（脚本会检查，没有则提示）
- `~/.local/bin` 在 PATH（不在则脚本提示）

## 可选：接定时器 / 注册 skill

`loop-tick` 已随安装装好，它是幂等单步 + stdout 摘要契约（空=静默），hermes cron / openclaw / crontab / systemd 读同一份输出：

```bash
*/5 * * * * loop-tick /path/to/your/project >> ~/loop-tick.log 2>&1
```

注册 skill 进当前 agent（symlink，不复制，换 agent 只改这一行）：

```bash
ln -sf ~/.local/share/loop/skill ~/.claude/skills/loop-scheduler   # Claude Code
ln -sf ~/.local/share/loop/skill ~/.codex/skills/loop-scheduler    # Codex
ln -sf ~/.local/share/loop/skill ~/.gemini/skills/loop-scheduler    # Gemini CLI
```

⚠️ `--cwd` 指向你要开发的目标项目（orchestrator 往那写产物 + git commit）。**别指向 loop 仓库自身。**
