# loop-orchestrator

24 小时无人值守开发 orchestrator —— 用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 驱动 Claude 自主完成一整个开发目标。

> 核心理念：**重但稳 + 使用简单**。长跑拆成幂等单步 `tick`，状态双层落盘，进程崩溃天然可恢复；用户视角只一条命令跑到底，调度器中立不绑任何外部 agent。

```bash
# 一条命令跑通：拆任务 + 自动推进到完成 + 自动 commit
npx tsx orchestrator.ts --cwd /path/to/project "构建一个 Go REST API"
```

---

## 架构图

### 整体：tick 化 + 双层持久化 + 调度器中立

```mermaid
flowchart TB
    User([用户 / 外部调度器])

    subgraph Modes["两种运行模式"]
        direction LR
        WATCH["--watch<br/>自驱：bootstrap + while tick()"]
        TICK["--tick<br/>单步：做一件事就退出"]
    end

    User -->|裸跑 / --watch| WATCH
    User -->|--tick| TICK

    subgraph Core["orchestrator.ts（进程内）"]
        direction TB
        BOOT["bootstrapTasks<br/>首跑拆任务 → .task.md"]
        TICKFN["tick() 无状态单步<br/>16 步幂等"]

        subgraph SDK["@anthropic-ai/claude-agent-sdk"]
            QUERY["query()<br/>进程内异步生成器"]
            HOOKS["PostToolUse hook<br/>实时捕文件写入"]
            WD["abortController<br/>事件驱动看门狗"]
        end

        BOOT --> TICKFN
        TICKFN -->|"每个未完成任务"| QUERY
        QUERY -.-> HOOKS
        QUERY -.-> WD
        HOOKS -->|"wroteFiles"| TICKFN
        QUERY -->|"结构化结果<br/>cost/session_id/subtype"| TICKFN
    end

    subgraph Persist["双层持久化（目标项目目录）"]
        direction LR
        STATE[("state.json<br/>恢复点·原子写<br/>cost/轮次/空转/commit/终止标记")]
        EVENTS[("events.jsonl<br/>审计流·append-only<br/>tick_started⇄completed 配对")]
        TASK[(".task.md<br/>任务进度真相源<br/>[ ]/[x]/[~]")]
        SESS[(".session_id<br/>会话单源")]
        STOP[(".stop 哨兵")]
        LOCK[(".tick.lock<br/>proper-lockfile")]
    end

    TICKFN -->|"阶段A 立即写成本"| STATE
    TICKFN --> STATE
    TICKFN --> EVENTS
    TICKFN --> TASK
    TICKFN --> SESS
    TICKFN -.-> STOP
    TICKFN -.-> LOCK

    subgraph Obs["观测命令"]
        STATUS["--status"]
        REPORT["--report"]
    end
    STATUS --> STATE
    STATUS --> EVENTS
    REPORT --> EVENTS

    style STATE fill:#e8f5e9
    style EVENTS fill:#e3f2fd
    style TICKFN fill:#fff3e0
```

### tick() 16 步控制流（崩溃恢复核心）

```mermaid
flowchart TD
    Start([tick 入口]) --> L0["步骤0 flock 非阻塞<br/>拿不到 → already_running"]
    L0 --> L1["步骤1 读 state.json 恢复"]
    L1 --> L2{"步骤2 .stop 哨兵?"}
    L2 -->|是| Stopped([stopped])
    L2 -->|否| L3{"步骤3 last_termination?"}
    L3 -->|有| AT([already_terminated<br/>防 cron 空转刷屏])
    L3 -->|无| L4["步骤4 读 .task.md<br/>取第一个 [ ]"]
    L4 --> L5["步骤5 append tick_started"]
    L5 --> L6{"步骤6 remaining=0?"}
    L6 -->|是, 有阻塞或零commit| SFC([疑假完成<br/>不设终止标记 待人工])
    L6 -->|是, 干净| Done([done 设终止标记])
    L6 -->|否| L7{"步骤7 预算耗尽?"}
    L7 -->|是| BE([budget_exceeded])
    L7 -->|否| L8["步骤8 stallTask 跨tick reset"]
    L8 --> L9["步骤9 loop_count++ 写盘 running"]
    L9 --> L10["步骤10 读 .session_id"]
    L10 --> L11["步骤11 runOneTask<br/>query + PostToolUse + 看门狗"]
    L11 --> L12["★步骤12 阶段A<br/>成本立即写 state.json<br/>在打勾/commit 之前"]
    L12 --> L13["步骤13 session_id 更新"]
    L13 --> L14{"步骤14 abort/<br/>ctx-overflow?"}
    L14 -->|是| SD["弃会话 session_retries++<br/>≥3 次标阻塞防死循环"]
    L14 -->|否, 单任务预算耗尽| TB(["标阻塞 不弃会话"])
    SD --> SDC([session_dropped])
    TB --> B2([blocked])
    L14 -->|否| L15{"步骤15 didRealWork?<br/>wroteFiles.length>0"}
    L15 -->|是| ADV["打勾 + commit +<br/>reset 空转/重试计数"]
    L15 -->|否| STALL["stall_count++<br/>≥3 标阻塞"]
    ADV --> L16(["advanced"])
    STALL --> L16b(["stalled / blocked"])
    L16 --> L17["步骤16 写 state.json<br/>+ 派生 .status<br/>+ tick_completed"]
    L16b --> L17
    SDC --> L17
    B2 --> L17
    L17 --> Release(["finally 释放 flock"])

    style L12 fill:#fff3e0
    style SFC fill:#ffebee
    style L11 fill:#e3f2fd
```

### 崩溃恢复时序

```mermaid
sequenceDiagram
    participant W as --watch 进程
    participant S as state.json
    participant E as events.jsonl
    participant T as 下一个 tick 进程

    W->>E: tick_started (tick_id=A)
    W->>S: status=running, loop_count=N
    Note over W: runOneTask 执行中...
    W->>S: ★阶段A 成本已落盘
    Note over W: 💀 kill -9 进程被强杀
    Note over E: tick_started(A) 无配对 tick_completed<br/>= 该 tick 崩溃（可检测）

    Note over T: 60s 后锁 stale 自动 takeover
    T->>S: 读 state.json（loop_count=N, 成本已含本轮）
    T->>E: 读到 tick_started(A) 无配对
    T->>E: tick_started (tick_id=B)
    Note over T: 从崩溃处续跑同任务<br/>loop_count=N+1<br/>state 不丢 / 不重复打勾
```

---

## 快速开始

```bash
# 1. 装依赖（一次）
npm install

# 2. 跑（产物写在 --cwd 指定的项目目录）
npx tsx orchestrator.ts --cwd /path/to/project "构建一个 Go REST API"
```

## 命令一览

| 命令 | 作用 |
|---|---|
| `orchestrator.ts --cwd <proj> "目标"` | 裸跑 = `--watch`，自驱跑到完成 |
| `--watch "目标"` | 显式自驱（bootstrap + `while(tick)`） |
| `--tick` | 单步，幂等可恢复（给调度器用） |
| `--status` | 实时状态（读 state.json + events.jsonl） |
| `--report` | 运行报告 |
| `--stop` | 停（写 `.stop` 哨兵 + 杀 `--watch`） |
| `--resume` | 清 `.stop` 哨兵恢复 |

`--cwd` 决定三件事，三者统一：① 产物写入处 ② `git commit` 的仓库 ③ 会话工作目录。不传则回退当前目录。**别在 loop 仓库根目录裸跑**——会把产物写进 loop 仓库并 commit 它。

---

## 两种运行模式

- **`--watch`（自驱）**：`bootstrapTasks` 拆任务 → `while(tick())` 跑到完成/停止/预算耗尽。长进程，命令行直跑用。终止类 outcome（done/budget_exceeded/already_terminated/stopped）break；already_running 退避 30s；其余 5s。
- **`--tick`（单步）**：取第一个未完成任务 → 执行 → 打勾/标阻塞 → commit → 退出。幂等、可随时 kill、kill 了下次接上。给外部调度器用。

## 调度器中立（tick 是接口）

orchestrator 不绑定任何调度器。`--tick` 是标准接口，任意能定时跑命令的都能驱动：

```bash
# 系统 crontab 每 5 分钟推进一步
*/5 * * * * cd /path/to/project && tsx /path/to/orchestrator.ts --tick >> night_run.log 2>&1

# 或 hermes cron / systemd timer / 另一个会话手敲 —— 都行
```

接哪个调度器是独立工作，orchestrator 本身不改。

---

## 稳定性设计（核心：成熟库兜底，不手写）

| 机制 | 实现 | 防什么 |
|---|---|---|
| 原子写 | `write-file-atomic`（data fsync + dir fsync） | state.json/.task.md 写一半被 kill 截断 |
| 进程级锁 | `proper-lockfile`（stale 60s 自动 takeover） | `--tick` 与 `--watch` / 手动与 cron 并发冲突；kill -9 残留锁 |
| **阶段A 财务保护** | runOneTask 返回立即写成本，在打勾/commit 之前 | 崩溃丢钱、预算守卫漏算超支 |
| 假完成三重校验 | 零改动不打勾 + 连续 3 次空转标阻塞 + 全程零 commit 不退出 | agent 空退/假完成 |
| ctx-overflow 重试 | 结构化判定（subtype+errors）+ 弃会话重开，连续 3 次标阻塞 | 上下文撑爆死循环 |
| 崩溃检测 | tick_started 与 tick_completed 配对（同 tick_id） | 发现未完成的崩溃 tick |

## 持久化文件

| 文件 | 作用 |
|---|---|
| `state.json` | 机器读恢复点（原子写）：成本/轮次/空转/commit/终止标记 |
| `events.jsonl` | append-only 审计流，`--status`/`--report` 从它读 |
| `.task.md` | 任务列表 + 勾选状态（`[ ]`/`[x]`/`[~]`）——进度真相源 |
| `.session_id` | Claude 会话 ID（单源，不进 state.json） |
| `.stop` | 停止哨兵（`--stop` 写，`--resume` 删） |
| `.tick.lock` | 进程级并发锁 |
| `night_run.log` | 人类可读文本日志 |

## 上下文管理（SDK 自带）

`autoCompactEnabled` 默认 true：上下文快满自动压成摘要，会话不中断、`session_id` 不变。真撑爆了（query 报 `error_during_execution` 含 context）→ 弃会话重开。orchestrator 这层不用管上下文。

---

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
- **崩溃恢复**：`kill -9` 后 state.json 完好、.task.md 未误打勾、锁 stale 自动 takeover、loop_count 不丢、下次 tick 从崩溃处续跑
- flock 并发：两个 `--tick` 同时，第二个立即 already_running
- `--stop` 哨兵：watch 收 SIGTERM 退出 + 写 .stop，`--resume` 恢复
- 假完成守卫：全 `[x]` 零 commit → 疑假完成，不设 last_termination 待人工介入

## 文件

| 文件 | 作用 |
|---|---|
| `orchestrator.ts` | 主程序（tick + watch + state/events 持久化） |
| `write-file-atomic.d.ts` | write-file-atomic v7 的 ambient 类型声明 |
| `package.json` / `tsconfig.json` | 依赖（proper-lockfile + write-file-atomic）与类型配置 |

## 依赖

| 依赖 | 用途 |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | 进程内 query() + hooks |
| `proper-lockfile` | 进程级并发锁（stale takeover） |
| `write-file-atomic` | 原子写（崩溃不截断） |
| `node:util` parseArgs | CLI 解析（零依赖内置） |
| `tsx` / `typescript`（dev） | 运行/类型检查 |
