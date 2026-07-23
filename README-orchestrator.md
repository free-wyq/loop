# loop-orchestrator

用 `@anthropic-ai/claude-agent-sdk` 重写的 24h 无人值守开发 orchestrator，替代 `unattended.sh`。

## 为什么重写

`unattended.sh` 是 bash 站在 claude **外面**，靠 `git diff` + 心跳文件**猜测** claude 干了什么、活着没。猜错了就假死，假死就轮询，轮询就死循环——multi-Agent 项目最后卡死在「疑假完成·1 任务空转，看门狗不退出反复报警」就是这个根。

SDK 版把"猜"换成"被告知"：进程内 `query()` 直接拿到结构化结果（`num_turns`/`total_cost_usd`/`session_id`），`PostToolUse` hook 实时收到每一次文件写入，`Stop` hook 同步通知轮结束。一整类 bash bug（`set -e` + `grep -c` + 命令替换杀脚本，修了 6 次）物理上消失。

## 用法

```bash
# 1. 装依赖（一次）
npm install

# 2. 启动（在目标项目目录下跑，它会把运行产物写在当前目录）
npx tsx /path/to/orchestrator.ts "构建一个 Go REST API"

# 实时状态 / 报告 / 停止
npx tsx orchestrator.ts --status
npx tsx orchestrator.ts --report
npx tsx orchestrator.ts --stop
```

> ⚠️ 跟 `unattended.sh` 一样，**在目标项目目录里跑**，别在 loop 仓库根目录跑——脚本会往当前目录写 `.task.md`/`.status`/`night_run.log`/`.pid`/`.session_id` 并 `git commit` 当前目录的 git 仓库。

## 对照表（orchestrator.ts vs unattended.sh）

| unattended.sh（bash） | orchestrator.ts（SDK） |
|---|---|
| `claude -p` 子进程 + `stream-json` grep 抓 session_id | `query()` 进程内 async generator，直接拿结构化消息 |
| 心跳文件 + 5min 轮询看门狗 | `PostToolUse`/`Stop` hook 实时刷新心跳 + `abortController` 超时 abort |
| `git diff --cached` 猜有没有干活 | `PostToolUse` hook 实时捕获写入 + `num_turns` |
| `--resume <id> -p` 每轮续接 | `options.resume = sessionId`（进程内续接） |
| 每 5 轮手动 `/compact` | auto-compact 默认开（无需手管） |
| `set -e` + `grep -c` 杀脚本（6 个 bug） | 纯 JS async，无 shell，这类 bug 不存在 |
| 无成本护栏 | `maxBudgetUsd` 单任务 + 全程双护栏 |
| `EnterPlanMode`/`AskUserQuestion` 卡住 | `disallowedTools` 直接从模型上下文移除 |
| 400 撑爆开新会话 | abort + 删 SESSION_FILE 下轮开新会话 |
| sed 打勾 | `tickFirst()`（保留 `.task.md` 格式兼容） |
| git commit + Co-Authored-By | `gitCommitIfChanged()`（逻辑一致） |

## 保留的行为

- `.task.md` 格式完全兼容（`- [ ]`/`- [x]`/`- [~]`），可跟旧脚本混用
- 会话策略不变：首轮新会话、后续 resume、**永不 continue**（防旧会话污染）
- 防假完成三重校验：零改动不打勾 + 连续 3 次空转标阻塞 + 全程零 commit 不退出
- 每轮自动 commit（本地不 push），带 Co-Authored-By trailer

## 验证状态

- ✅ smoke.ts：单 `query()` 跑通，拿到 `num_turns=2`/`session_id`/`cost`，`PostToolUse` 捕获到 `Write:/path`
- ✅ e2e：3 任务全跑通，3 个真 commit，`--status`/`--report` 正常，全程 $1.95
- ✅ 修复 git 退出码 bug：`git diff --cached --quiet` 退出码 1（有暂存）会抛异常，必须 try/catch 捕 status，不能靠返回值判

## 文件

| 文件 | 作用 |
|---|---|
| `orchestrator.ts` | 主程序（替代 `unattended.sh`） |
| `smoke.ts` | 最小验证脚本 |
| `package.json` / `tsconfig.json` | 依赖与类型配置 |

`unattended.sh` 保留作为 bash 版兜底，不删。
