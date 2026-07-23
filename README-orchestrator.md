# loop-orchestrator

用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 实现的 24h 无人值守开发 orchestrator。

核心思想：**重但稳 + 使用简单**。把长跑拆成幂等单步 `tick`，状态双层落盘（`state.json` 恢复点 + `events.jsonl` 审计流），进程崩溃天然可恢复；用户视角只一条命令跑到底，调度器中立（hermes cron / 系统 crontab / 手敲 `--tick` 都能驱动，不绑任何外部 agent）。

## 用法（最简：一条命令）

```bash
# 1. 装依赖（一次，在 loop 仓库）
npm install

# 2. 在目标项目里跑（裸跑 = --watch：拆任务 + 自动推进到完成）
npx tsx /path/to/orchestrator.ts --cwd /path/to/project "构建一个 Go REST API"
```

就这一条。拆任务、执行、自动 commit、撞上下文自动弃会话重试、崩溃后下次接着跑——全自动。

## 命令

```bash
npx tsx orchestrator.ts --cwd <项目> "目标"     # 裸跑=--watch，自驱跑到完成
npx tsx orchestrator.ts --cwd <项目> --watch "目标"   # 显式自驱
npx tsx orchestrator.ts --cwd <项目> --tick    # 单步（幂等可恢复，给外部调度器用）
npx tsx orchestrator.ts --cwd <项目> --status   # 实时状态（读 state.json + events.jsonl）
npx tsx orchestrator.ts --cwd <项目> --report   # 运行报告
npx tsx orchestrator.ts --cwd <项目> --stop     # 停（写 .stop 哨兵 + 杀 --watch）
npx tsx orchestrator.ts --cwd <项目> --resume   # 清 .stop 哨兵恢复
```

`--cwd` 决定三件事，三者统一指向它：① 产物写入处 ② `git commit` 的仓库 ③ 会话工作目录。不传则回退当前目录。**别在 loop 仓库根目录裸跑**——会把产物写进 loop 仓库并 commit 它。

## 两种运行模式

- **`--watch`（自驱）**：bootstrap 拆任务 → `while(tick())` 跑到完成/停止/预算耗尽。长进程，命令行直跑用。
- **`--tick`（单步）**：取第一个未完成任务 → 执行 → 打勾/标阻塞 → commit → 退出。幂等、可随时 kill、kill 了下次接上。给外部调度器（cron/systemd/hermes cron）用。

## 调度器中立（tick 是接口）

orchestrator 不绑定任何调度器。`--tick` 是标准接口，任意能定时跑命令的东西都能驱动：

```bash
# 系统 crontab 每 5 分钟推进一步
*/5 * * * * cd /path/to/project && tsx /path/to/orchestrator.ts --tick >> night_run.log 2>&1

# 或 hermes cron / systemd timer / 另一个会话手敲 —— 都行
```

接哪个调度器是独立工作，orchestrator 本身不改。

## 持久化与崩溃恢复

| 文件 | 作用 |
|---|---|
| `state.json` | 机器读恢复点（原子写）：成本/轮次/空转/commit 标记/终止标记。tick 入口读、出口写 |
| `events.jsonl` | append-only 审计流，`--status`/`--report` 从它读。tick_started 与 tick_completed 配对，无配对 = 该 tick 崩溃 |
| `.task.md` | 任务列表 + 勾选状态（`[ ]`/`[x]`/`[~]`）——进度真相源 |
| `.session_id` | Claude 会话 ID（单源，不进 state.json） |
| `.stop` | 停止哨兵（`--stop` 写，`--resume` 删） |
| `.tick.lock` | 进程级并发锁（proper-lockfile，stale 60s 自动 takeover） |
| `night_run.log` | 人类可读文本日志 |

**稳的关键（成熟库兜底，不手写）**：
- `write-file-atomic`：原子写 state.json/.task.md（data fsync + dir fsync 顺序，崩溃后元数据不丢）
- `proper-lockfile`：并发互斥 + 进程 kill -9 后 stale lock 自动清理
- **阶段A 财务保护**：runOneTask 一返回就立即把成本写进 state.json（在打勾/commit 之前），崩溃也不丢钱
- 防假完成三重校验：零改动不打勾 + 连续 3 次空转标阻塞 + 全程零 commit 不退出（且不设终止标记，待人工介入）
- ctx-overflow 弃会话重试（连续 3 次标阻塞防死循环）

## 上下文管理（SDK 自带）

`autoCompactEnabled` 默认 true：上下文快满自动压成摘要，会话不中断、`session_id` 不变。真撑爆了（query 报 `error_during_execution` 含 context）→ 弃会话重开。orchestrator 这层不用管上下文。

## 核心机制

- 进程内 `query()`，结构化结果直出（不再 spawn `claude -p` 子进程 grep stream-json）
- `PostToolUse` hook 实时捕获真实文件写入 → 完成判定看真实事件（不靠 `git diff` 猜）
- `abortController` + `Stop` hook 刷新心跳 → 看门狗事件驱动，不轮询
- `disallowedTools` 移除 `EnterPlanMode`/`ExitPlanMode`/`AskUserQuestion`（防卡住）
- `maxBudgetUsd` 单任务 + 全程双护栏
- 会话策略：首轮新会话、后续 resume、**永不 continue**（防旧会话污染）
- 每轮自动 commit（本地不 push），带 Co-Authored-By trailer

## 验证

- e2e happy path：2 任务全跑通、2 commit、events 配对完整、state.json 正确
- **崩溃恢复**：watch 跑到一半 `kill -9` → state.json 完好无损、.task.md 未误打勾、锁 stale 后自动 takeover、下次 tick 从崩溃处续跑（loop_count 不丢）
- flock 并发：两个 `--tick` 同时跑，第二个立即 already_running
- `--stop` 哨兵：watch 收到 SIGTERM 退出 + 写 .stop，`--resume` 恢复
- 假完成守卫：全 `[x]` 零 commit → 疑假完成，不设 last_termination（待人工介入，不空转刷屏）
- 修过 git 退出码 bug：`git diff --cached --quiet` 有暂存时退出码 1 抛异常，必须 try/catch 捕 status

## 文件

| 文件 | 作用 |
|---|---|
| `orchestrator.ts` | 主程序（tick + watch + state/events 持久化） |
| `write-file-atomic.d.ts` | write-file-atomic v7 的 ambient 类型声明（v7 不自带类型） |
| `package.json` / `tsconfig.json` | 依赖（proper-lockfile + write-file-atomic）与类型配置 |
