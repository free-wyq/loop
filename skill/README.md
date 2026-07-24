# loop-scheduler skill

loop-orchestrator 接入说明。**orchestrator 只管推进 + 结果结构化落盘，战报由外部 agent（如 claw）读结果自行发送。**

## 职责边界

- orchestrator：推进 + `state.json`(恢复点) + `events.jsonl`(审计流) 落盘。不发战报。
- claw 等 agent：定时读 state/events/.task.md，自行组织战报推送。文案/频道/频率全由 agent 定。

推进靠 `--watch` 长进程，崩了重启续跑，不依赖外部触发。推进与观察彻底解耦。

## 结构化结果（战报数据源）

- **state.json**：goal / total_cost_usd / loop_count / stall_count / had_any_commit / session_retries / status / last_termination。`status` 关键值：running / idle / completed / blocked_suspect(疑假完成) / budget_exceeded / ctx_overflow_retry。
- **events.jsonl**：append-only 事件流。`tick_started` 无同 tick_id 的 `tick_completed` = 该 tick 崩溃。
- **.task.md**：任务勾选 `[ ]`/`[x]`/`[~]`，进度真相源。

## 文件

| 文件 | 作用 |
|---|---|
| `SKILL.md` | skill 说明（agent 读它执行安装/操作） |
| `loop-tick.conf.example` | 目标项目配置模板（拷成 `~/.config/loop-tick.conf`） |

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/free-wyq/loop/main/install.sh | bash
```

装好 `loop` 到 `~/.local/bin`，自动配 conf。用法见 [SKILL.md](SKILL.md)。

## 注册成当前 agent 的 skill（可选）

多数 agent 的 skill 扫描器用 find/glob 遍历 skills 目录、**默认不跟 symlink 进子目录**——symlink 进去扫描器看不见。拷成真目录：

```bash
# 推理你 agent 的 skills 目录（常见：~/.claude/skills · ~/.codex/skills · ~/.gemini/skills · ~/.cursor/skills · ~/.hermes/skills）
SKILLS_DIR=~/.claude/skills
mkdir -p "$SKILLS_DIR"; rm -rf "$SKILLS_DIR/loop-scheduler"
cp -r /path/to/loop/skill "$SKILLS_DIR/loop-scheduler"
# 验证：find "$SKILLS_DIR/loop-scheduler" -name SKILL.md   # 应返回一行
```
