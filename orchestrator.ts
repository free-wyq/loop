// orchestrator.ts —— SDK 版 24h 无人值守开发 orchestrator
//
// 用法：
//   npx tsx orchestrator.ts "目标"      # 启动（拆任务 + 主循环）
//   npx tsx orchestrator.ts --status    # 看实时状态
//   npx tsx orchestrator.ts --stop      # 停止
//   npx tsx orchestrator.ts --report     # 报告
//
// 会话策略：首轮新会话（query 返回的 session_id 落盘），后续轮 resume 同一会话；
// 永不使用 continue（避免旧会话污染）。

import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";

// ---------------- 配置 ----------------

const TASK_FILE = ".task.md";
const LOG_FILE = "night_run.log";
const STATUS_FILE = ".status";
const MEMO_DIR = ".claude/memory";
const SESSION_FILE = ".session_id";
const PID_FILE = ".pid";

const MAX_TURNS_PER_TASK = 60;      // 单任务 agentic 轮上限（防一个任务跑飞）
const MAX_BUDGET_PER_TASK = 3;      // 单任务美元上限
const MAX_BUDGET_TOTAL = 50;        // 全程美元上限（24h 护栏）
const STALL_LIMIT = 3;              // 同任务连续零改动 N 次标阻塞
const ABORT_TIMEOUT_MIN = 60;       // 单任务超 N 分钟无进展则 abort 重试

// ---------------- 工具函数 ----------------

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function log(msg: string) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

interface Status {
  last_heartbeat: string;
  status: string;
  current_task: string;
  remaining: number;
  completed: number;
  cost_usd: number;
}

function writeStatus(s: Omit<Status, "last_heartbeat">) {
  const st: Status = { last_heartbeat: now(), ...s };
  writeFileSync(STATUS_FILE,
    `last_heartbeat: ${st.last_heartbeat}\nstatus: ${st.status}\ncurrent_task: ${st.current_task}\nremaining: ${st.remaining}\ncompleted: ${st.completed}\ncost_usd: ${st.cost_usd.toFixed(4)}\n`);
}

function readStatus(): Partial<Status> | null {
  if (!existsSync(STATUS_FILE)) return null;
  const obj: Record<string, string> = {};
  for (const line of readFileSync(STATUS_FILE, "utf8").split("\n")) {
    const idx = line.indexOf(": ");
    if (idx > 0) obj[line.slice(0, idx)] = line.slice(idx + 2);
  }
  return obj as unknown as Partial<Status>;
}

// ---- 任务文件读写（.task.md 格式）----

interface Tasks { total: number; remaining: number; }

function readTasks(): Tasks {
  if (!existsSync(TASK_FILE)) return { total: 0, remaining: 0 };
  const text = readFileSync(TASK_FILE, "utf8");
  const lines = text.split("\n");
  let total = 0, rem = 0;
  for (const l of lines) {
    const m = l.match(/^- \[([ x~])\]/);
    if (!m) continue;
    total++;
    if (m[1] === " ") rem++;
  }
  return { total, remaining: rem };
}

function currentTaskLine(): string | null {
  if (!existsSync(TASK_FILE)) return null;
  for (const l of readFileSync(TASK_FILE, "utf8").split("\n")) {
    if (/^- \[ \]/.test(l)) return l;
  }
  return null;
}

// 把第一个未完成任务行打勾 [ ]→[x]
function tickFirst() {
  const text = readFileSync(TASK_FILE, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[ \]/.test(lines[i])) {
      lines[i] = lines[i].replace(/^- \[ \]/, "- [x]");
      writeFileSync(TASK_FILE, lines.join("\n"));
      return;
    }
  }
}

// 标记阻塞 [ ]→[~]
function blockFirst() {
  const text = readFileSync(TASK_FILE, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[ \]/.test(lines[i])) {
      lines[i] = lines[i].replace(/^- \[ \]/, "- [~]");
      writeFileSync(TASK_FILE, lines.join("\n"));
      return;
    }
  }
}

// ---------------- git 提交 ----------------

function git(args: string[]): { stdout: string; status: number } {
  // execFileSync 失败（退出码非 0）时抛异常，必须 try/catch 捕 status：
  // git diff --cached --quiet 退出码 1（有暂存改动）会抛异常，退出码 0（无改动）返回空串。
  try {
    const stdout = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { stdout, status: 0 };
  } catch (e) {
    return { stdout: (e as { stdout?: string }).stdout ?? "", status: (e as { status?: number }).status ?? 1 };
  }
}

function gitCommitIfChanged(taskLine: string): boolean {
  if (!existsSync(".git")) return false;
  git(["add", "-A"]);
  const { status } = git(["diff", "--cached", "--quiet"]);  // 0=无暂存；非0=有暂存
  if (status === 0) return false;
  const tagMatch = taskLine.match(/\[([A-Z]+-[0-9]+)\]/);
  const desc = taskLine.replace(/^- \[[ x~]\] /, "").replace(/\[[A-Z]*-[0-9]*\]\s*/g, "").slice(0, 200);
  const msg = tagMatch ? `feat(${tagMatch[1]}): ${desc}` : `feat: ${desc}`;
  git(["commit", "-m", msg, "-m", "Co-Authored-By: Claude <noreply@anthropic.com>", "--no-verify", "--quiet"]);
  return true;
}

// ---------------- 核心：单任务一轮 query ----------------

interface RoundOutcome {
  result: SDKResultMessage | null;
  wroteFiles: string[];    // PostToolUse hook 捕获的文件写入
  toolCalls: number;       // 总工具调用数
  aborted: boolean;
}

// 铁律 prompt：禁提问 + 自主决策 + 已完成检测（防假完成）
function buildPrompt(taskLine: string): string {
  return `## 角色
你是无人值守开发助手，当前处于 24 小时自动运行模式。全程没有任何人在场，你必须独立完成决策。

## 铁律（违反会导致系统崩溃）
1. 绝对不要向用户提问任何问题，不要等待确认。
2. 执行任务过程中遇到任何选择或决策点，自己直接做决定，选最优解，不要询问用户。
3. 如果进入计划模式，直接执行计划，不要等待批准。
4. 如果检测到危险操作，低风险直接执行，高风险跳过并在 progress.md 说明原因。
5. 基于最佳实践自行推断，绝不索要额外信息。宁可基于合理假设推进，也不要停下来等。
6. 遇到报错或失败，自己排查、自己修，不要向用户求助。

## 已完成检测（防假完成）
「该任务对应的代码可能已存在」≠「已实现完整」。必须区分：
- ✅ 实现完整：目标函数有真实业务逻辑（非 pass / 非 NotImplementedError 占位 / 非 docstring+pass）。
- ❌ 不算完成：只有骨架/占位/签名+pass/TODO-docstring。
判定完整前必须用 Read 打开函数体看是不是真实逻辑，不是看函数名是否存在。
若只有骨架/占位 → 必须补完真实实现，不能空退（空退会被判空转标阻塞）。

## 本轮任务（只做这一个）
任务：${taskLine}

## 流程
1. 【必做第一步·已完成检测】Read/Grep 检查目标文件是否已存在且实现完整。完整→直接结束本轮。不完整→继续。
2. 读 .task.md 确认第一个未完成任务与上面一致。
3. 读 .claude/memory/ 了解项目背景。
4. 执行任务（代码写到文件）。遇到决策点自己拍板。
5. 更新 .claude/memory/progress.md。

## 规则
- 一次只做一个任务。不要自己改 .task.md 勾选状态——打勾由外部脚本负责。
- 本轮结束直接结束，不要输出总结。`;
}

async function runOneTask(taskLine: string, sessionId: string | null, costSoFar: number): Promise<RoundOutcome> {
  const ac = new AbortController();
  const wroteFiles: string[] = [];
  let toolCalls = 0;
  let lastHeartbeat = Date.now();

  // 看门狗计时器：单任务超过 ABORT_TIMEOUT_MIN 分钟无 PostToolUse 进展 → abort
  let watchdog: NodeJS.Timeout | null = null;
  const startWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (Date.now() - lastHeartbeat > ABORT_TIMEOUT_MIN * 60_000) {
        log(`⏱️ 单任务 ${ABORT_TIMEOUT_MIN}m 无进展，abort 重试`);
        ac.abort();
      }
    }, (ABORT_TIMEOUT_MIN + 5) * 60_000);
  };
  startWatchdog();

  const options: Parameters<typeof query>[0]["options"] = {
    abortController: ac,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: MAX_TURNS_PER_TASK,
    maxBudgetUsd: Math.min(MAX_BUDGET_PER_TASK, MAX_BUDGET_TOTAL - costSoFar),
    disallowedTools: ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"],
    hooks: {
      // PostToolUse 实时捕获真实改动 —— 取代 git diff 猜测
      PostToolUse: [{
        hooks: [async (input) => {
          lastHeartbeat = Date.now();     // 任何工具调用都刷新心跳
          startWatchdog();
          toolCalls++;
          if (input.hook_event_name !== "PostToolUse") return {};
          const ti = input.tool_input as Record<string, unknown> | undefined;
          const path = ti?.file_path ?? ti?.path ?? ti?.notebook_path;
          if (typeof path === "string" && /Write|Edit|MultiEdit|NotebookEdit/.test(input.tool_name)) {
            wroteFiles.push(`${input.tool_name}:${path}`);
          }
          return {};
        }],
      }],
      // Stop 只用来刷新心跳（单轮靠 for-await result 决定停，不 block）
      Stop: [{
        hooks: [async () => { lastHeartbeat = Date.now(); return {}; }],
      }],
    },
  };

  if (sessionId) {
    options.resume = sessionId;   // 续接同一会话（永不用 continue）
  }

  const q = query({ prompt: buildPrompt(taskLine), options });

  let resultMsg: SDKResultMessage | null = null;
  let aborted = false;
  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "result") {
        resultMsg = msg as SDKResultMessage;
      }
    }
  } catch (e) {
    if (ac.signal.aborted) aborted = true;
    else log(`⚠️ query 异常: ${(e as Error).message}`);
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }

  return { result: resultMsg, wroteFiles, toolCalls, aborted };
}

// ---------------- 主循环 ----------------

async function mainLoop() {
  writeFileSync(PID_FILE, String(process.pid));
  log(`orchestrator 主进程启动，PID=${process.pid}`);

  mkdirSync(MEMO_DIR, { recursive: true });

  // 会话策略：读已落盘的 session_id；没有则首轮开新会话
  let sessionId: string | null = existsSync(SESSION_FILE)
    ? readFileSync(SESSION_FILE, "utf8").trim() || null
    : null;

  let totalCost = 0;
  let loopCount = 0;
  let stallTask: string | null = null;
  let stallCount = 0;
  let hadAnyCommit = false;

  while (true) {
    const { total, remaining } = readTasks();

    if (remaining === 0) {
      // 防假完成：有阻塞标记或全程零 commit → 不退出，挂起待人工核实
      const text = existsSync(TASK_FILE) ? readFileSync(TASK_FILE, "utf8") : "";
      const blocked = (text.match(/^- \[~\]/gm) || []).length;
      if (blocked > 0) {
        log(`⚠️ 检测到 ${blocked} 个 [~] 阻塞任务 + remaining=0：疑假完成，挂起待人工核实`);
        writeStatus({ status: "blocked", current_task: `疑假完成·${blocked} 任务阻塞`, remaining: 0, completed: total, cost_usd: totalCost });
        await sleep(300_000);
        continue;
      }
      if (!hadAnyCommit) {
        log("⚠️ remaining=0 但全程零 commit：疑假完成，挂起待人工核实");
        writeStatus({ status: "blocked", current_task: "疑假完成·全程零commit", remaining: 0, completed: total, cost_usd: totalCost });
        await sleep(300_000);
        continue;
      }
      log(`✅ 全部完成！共 ${total} 个任务，总花费 $${totalCost.toFixed(4)}`);
      writeStatus({ status: "completed", current_task: "全部完成", remaining: 0, completed: total, cost_usd: totalCost });
      rmSync(PID_FILE, { force: true });
      return;
    }

    if (totalCost >= MAX_BUDGET_TOTAL) {
      log(`🛑 达到全程预算上限 $${MAX_BUDGET_TOTAL}，停止`);
      writeStatus({ status: "budget_exceeded", current_task: "预算耗尽", remaining, completed: total - remaining, cost_usd: totalCost });
      rmSync(PID_FILE, { force: true });
      return;
    }

    const taskLine = currentTaskLine()!;
    loopCount++;
    log("━".repeat(60));
    log(`🔄 第 ${loopCount} 轮 | 剩余 ${remaining}/${total}`);
    log(`📋 ${taskLine}`);
    writeStatus({ status: "running", current_task: taskLine, remaining, completed: total - remaining, cost_usd: totalCost });

    const { result, wroteFiles, toolCalls, aborted } = await runOneTask(taskLine, sessionId, totalCost);

    // 完成判定看真实结构化信号，不是 git diff 猜测
    const didRealWork = wroteFiles.length > 0;
    const taskKey = taskLine.slice(0, 120);

    if (result?.session_id && result.session_id !== sessionId) {
      sessionId = result.session_id;
      writeFileSync(SESSION_FILE, sessionId);
      if (loopCount === 1) log(`🔗 新会话已建立: ${sessionId}`);
    }

    if (result) {
      totalCost += result.total_cost_usd ?? 0;
      if (result.subtype !== "success") {
        log(`⚠️ 本轮非 success: subtype=${result.subtype} stop_reason=${result.stop_reason}`);
      }
    }

    // 撞上下文撑爆/超时：弃会话下轮开新会话重试同任务，不标阻塞
    if (aborted || (result && /context length|exceeds/i.test(JSON.stringify(result)))) {
      log("🧠 疑上下文撑爆/超时，弃会话下轮开新会话重试同任务");
      rmSync(SESSION_FILE, { force: true });
      sessionId = null;
      stallTask = null; stallCount = 0;
      writeStatus({ status: "ctx-overflow-retry", current_task: taskLine, remaining, completed: total - remaining, cost_usd: totalCost });
      await sleep(5_000);
      continue;
    }

    if (didRealWork) {
      tickFirst();
      const committed = gitCommitIfChanged(taskLine);
      if (committed) hadAnyCommit = true;
      log(`⏱️ 第 ${loopCount} 轮结束：写入 ${wroteFiles.length} 文件 / ${toolCalls} 工具调用 / $${(result?.total_cost_usd ?? 0).toFixed(4)}（${committed ? "已提交" : "无暂存"}）`);
      stallTask = null; stallCount = 0;
    } else {
      // 零改动：worker 判了"已完成"但没写代码 → 记空转，不打勾
      stallTask = taskKey; stallCount++;
      log(`⏸️ 零改动空转 #${stallCount}: ${taskKey}`);
      if (stallCount >= STALL_LIMIT) {
        blockFirst();
        log(`🚧 连续 ${STALL_LIMIT} 次空转，标 [~] 阻塞跳过，推进下一任务`);
        stallTask = null; stallCount = 0;
      }
    }

    const { remaining: newRem } = readTasks();
    writeStatus({ status: "idle", current_task: taskLine, remaining: newRem, completed: total - newRem, cost_usd: totalCost });

    await sleep(5_000);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------- 首次任务拆解 ----------------

async function bootstrapTasks(goal: string) {
  log("首次运行，拆解任务...");
  log(`目标：${goal}`);
  const q = query({
    prompt: `根据用户目标拆解为最小可执行任务列表。
用户目标：${goal}
要求：
- 每个任务足够小（一个函数、一个文件、一个接口）
- 按依赖顺序排列
- 输出格式只有任务列表，每行一个：
- [ ] 任务描述
- [ ] 任务描述
...`,
    options: {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 5,
      maxBudgetUsd: 1,
      disallowedTools: ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"],
    },
  });
  let text = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      const r = msg as SDKResultMessage;
      text = r.subtype === "success" ? (r.result ?? "") : (r.errors ?? []).join("\n");
    } else if (msg.type === "assistant") {
      const content = (msg as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
            text += (b as { text?: string }).text ?? "";
          }
        }
      }
    }
  }
  const taskLines = text.split("\n").filter((l) => /^- \[ \]/.test(l));
  writeFileSync(TASK_FILE, taskLines.join("\n") + "\n");
  if (taskLines.length === 0) {
    log("❌ 任务拆解失败");
    process.exit(1);
  }
  log(`✅ 共 ${taskLines.length} 个任务`);
}

// ---------------- 状态 / 报告 ----------------

function showStatus() {
  const st = readStatus();
  if (st) {
    console.log(`last_heartbeat: ${st.last_heartbeat}`);
    console.log(`status: ${st.status}`);
    console.log(`current_task: ${st.current_task}`);
    console.log(`remaining: ${st.remaining}`);
    console.log(`completed: ${st.completed}`);
    console.log(`cost_usd: ${st.cost_usd}`);
  } else {
    console.log("暂无状态文件");
  }
  console.log("");
  console.log("进程状态：");
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    try { process.kill(pid, 0); console.log(`  主进程: 运行中 PID=${pid}`); }
    catch { console.log(`  主进程: 未运行 (PID 文件残留 ${pid})`); }
  } else {
    console.log("  主进程: 未运行");
  }
}

function showReport() {
  console.log("━".repeat(60));
  console.log("📊 无人值守运行报告");
  console.log("━".repeat(60));
  if (existsSync(TASK_FILE)) {
    const { total, remaining } = readTasks();
    const done = total - remaining;
    console.log(`任务进度: ${done} / ${total} 已完成`);
  }
  const st = readStatus();
  if (st) { console.log("\n最后状态:"); for (const [k, v] of Object.entries(st)) console.log(`  ${k}: ${v}`); }
  if (existsSync(LOG_FILE)) {
    const logText = readFileSync(LOG_FILE, "utf8");
    console.log("\n异常/报错：");
    const errs = logText.split("\n").filter((l) => /错误|失败|❌|异常|假死|空转|阻塞/.test(l)).slice(-20);
    console.log(errs.length ? errs.join("\n") : "（未发现）");
  }
}

function stopAll() {
  log("收到停止指令");
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    try {
      process.kill(pid, "SIGTERM");
      console.log(`主进程已停止 (PID=${pid})`);
    } catch { console.log("主进程未运行"); }
    rmSync(PID_FILE, { force: true });
  } else {
    console.log("主进程未运行");
  }
}

// ---------------- 入口 ----------------

async function main() {
  const arg = process.argv[2] ?? "";

  if (arg === "--status") { showStatus(); return; }
  if (arg === "--report") { showReport(); return; }
  if (arg === "--stop") { stopAll(); return; }

  if (!existsSync(TASK_FILE)) {
    if (!arg) {
      console.error('首次运行需要指定目标，例如：\n  npx tsx orchestrator.ts "构建一个Go REST API"');
      process.exit(1);
    }
    await bootstrapTasks(arg);
  }
  await mainLoop();
}

main().catch((e) => {
  log(`💥 orchestrator 崩溃: ${e?.stack || e}`);
  rmSync(PID_FILE, { force: true });
  process.exit(1);
});
