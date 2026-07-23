# loop-orchestrator

用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 实现的 24h 无人值守开发 orchestrator。

进程内 `query()` 直接拿到结构化结果（`num_turns`/`total_cost_usd`/`session_id`），`PostToolUse` hook 实时收到每一次文件写入，`Stop` hook 同步通知轮结束，`abortController` 做事件驱动看门狗。

## 用法

```bash
# 1. 装依赖（一次）
npm install

# 2. 在目标项目目录里启动（产物写在当前目录）
npx tsx /path/to/orchestrator.ts "构建一个 Go REST API"

# 实时状态 / 报告 / 停止
npx tsx orchestrator.ts --status
npx tsx orchestrator.ts --report
npx tsx orchestrator.ts --stop
```

> ⚠️ **在目标项目目录里跑**，别在 loop 仓库根目录跑——脚本会往当前目录写 `.task.md`/`.status`/`night_run.log`/`.pid`/`.session_id` 并 `git commit` 当前目录的 git 仓库。

## 核心机制

- 进程内 `query()`，结构化结果直出，不再 spawn `claude -p` 子进程
- `PostToolUse` hook 实时捕获真实文件写入 → 完成判定看真实事件
- `abortController` + `Stop` hook 刷新心跳 → 看门狗事件驱动，不轮询
- `disallowedTools` 移除 `EnterPlanMode`/`ExitPlanMode`/`AskUserQuestion`（防卡住）
- `maxBudgetUsd` 单任务 + 全程双护栏
- auto-compact 默认开

## 保留行为

- `.task.md` 格式（`- [ ]`/`- [x]`/`- [~]`）
- 会话策略：首轮新会话、后续 resume、**永不 continue**（防旧会话污染）
- 防假完成三重校验：零改动不打勾 + 连续 3 次空转标阻塞 + 全程零 commit 不退出
- 每轮自动 commit（本地不 push），带 Co-Authored-By trailer

## 验证

- e2e：3 任务全跑通，3 个真 commit，`--status`/`--report` 正常，同一 session 续接 3 轮
- 修过 git 退出码 bug：`git diff --cached --quiet` 有暂存时退出码 1 抛异常，必须 try/catch 捕 status

## 文件

| 文件 | 作用 |
|---|---|
| `orchestrator.ts` | 主程序 |
| `package.json` / `tsconfig.json` | 依赖与类型配置 |
