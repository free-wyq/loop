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

## 配置密钥 / 走代理（重要）

cron / systemd / hermes cron 这类**非交互调度器跑的是干净 env，不会 source `~/.bashrc`**——你写在 `~/.bashrc` 里的 `ANTHROPIC_API_KEY` 它们根本拿不到（实测：调度器里得手 export + sed 抠 `~/.bashrc` 才跑得通，极脆、还常触发审批）。

把密钥写进 `~/.config/loop.env` 一份，orchestrator 启动会自动读进环境（已 export 的不覆盖）：

```bash
cp ~/.local/share/loop/loop.env.example ~/.config/loop.env
chmod 600 ~/.config/loop.env   # 密钥别让别的用户读到
# 编辑 ~/.config/loop.env，填 ANTHROPIC_API_KEY=sk-...
#   走代理才加：ANTHROPIC_BASE_URL=http://192.168.241.10:3000
#   走代理才加：ANTHROPIC_MODEL=glm-5.1（及其它 ANTHROPIC_DEFAULT_*_MODEL）
```

> 想换路径：`export LOOP_ENV_FILE=/path/to/your.env`。

## 限额（默认不限；想要护栏再设）

自托管 / 免费代理的模型**没有按量计费**，预算护栏纯属挡路（实测：GLM 代理单任务 $3、bootstrap $1 都不够会崩成 `blocked`/拆解失败）。所以默认全部 `0 = 不限`。要护栏再在 `loop.env` 里设正数：

| 变量 | 默认 | 含义 |
|---|---|---|
| `LOOP_MAX_TURNS` | 0（不限） | 单任务最大轮数 |
| `LOOP_MAX_BUDGET_PER_TASK` | 0（不限） | 单任务美元上限 |
| `LOOP_MAX_BUDGET_TOTAL` | 0（不限） | 全程美元上限 |
| `LOOP_BOOTSTRAP_MAX_TURNS` | 0（不限） | bootstrap（任务拆解）最大轮数 |
| `LOOP_BOOTSTRAP_MAX_BUDGET` | 0（不限） | bootstrap 美元上限 |
| `LOOP_STALL_LIMIT` | 3 | 同任务连续零改动 N 次标阻塞 |
| `LOOP_ABORT_TIMEOUT_MIN` | 60 | 单任务超 N 分钟无进展则 abort 重试 |
| `LOOP_SESSION_RETRY_LIMIT` | 3 | 当前任务连续 ctx 撑爆 N 次标阻塞 |

## 可选：接定时器 / 注册 skill

`loop-tick` 已随安装装好，它是幂等单步 + stdout 摘要契约（空=静默），hermes cron / openclaw / crontab / systemd 读同一份输出：

```bash
*/5 * * * * loop-tick /path/to/your/project >> ~/loop-tick.log 2>&1
```

注册 skill 进当前 agent（**拷成真目录，不要用 symlink**）：

多数 agent 的 skill 扫描器用 find/glob 遍历 skills 目录，默认不跟符号链接进子目录——symlink 进去的 skill 对 agent 不可见（实测：`find <skills>/loop-scheduler -name SKILL.md` 对 symlink 返回空，对真目录正常）。所以拷真目录：

```bash
# 1. 推理你 agent 的 skills 目录（常见位置，按你实际用的判断；不确定就查该 agent 文档）：
#    Claude Code ~/.claude/skills · Codex ~/.codex/skills · Gemini CLI ~/.gemini/skills
#    Cursor ~/.cursor/skills · Hermes ~/.hermes/skills
SKILLS_DIR=~/.claude/skills

# 2. 拷成真目录（loop 升级后重跑这两行刷新 skill 内容）
mkdir -p "$SKILLS_DIR"
rm -rf "$SKILLS_DIR/loop-scheduler"
cp -r ~/.local/share/loop/skill "$SKILLS_DIR/loop-scheduler"
```

卸载时删那个真目录：`rm -rf "$SKILLS_DIR/loop-scheduler"`（`install.sh uninstall` 也会顺带清各已知 agent 目录下的 loop-scheduler，无论 symlink 还是真目录）。你用的 agent 若不在默认列表里，卸载前 `export LOOP_SKILL_DIRS=<skills-dir>:<skills-dir>` 再 uninstall，脚本会一并清理。

⚠️ `--cwd` 指向你要开发的目标项目（orchestrator 往那写产物 + git commit）。**别指向 loop 仓库自身。**
