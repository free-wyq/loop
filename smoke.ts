// smoke.ts —— 最小验证：跑一个真 query()，确认能拿到结构化结果
// 用法：npx tsx smoke.ts
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

const ac = new AbortController();
// 兜底：90 秒没结束就 abort，防止 smoke 卡死
const timer = setTimeout(() => ac.abort(), 90_000);

let turns = 0;
let touchedFiles: string[] = [];

const q = query({
  prompt: `在一个空目录里创建文件 hello.txt，内容写一行 "hello from sdk"。只做这一件事，做完就停。`,
  options: {
    abortController: ac,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 10,
    maxBudgetUsd: 1,
    disallowedTools: ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"],
    hooks: {
      PostToolUse: [
        {
          hooks: [
            async (input) => {
              turns++;
              if (input.hook_event_name !== "PostToolUse") return {};
              const ti = input.tool_input as Record<string, unknown> | undefined;
              const path = ti?.file_path ?? ti?.path ?? ti?.notebook_path;
              if (typeof path === "string" && input.tool_name.match(/Write|Edit|MultiEdit|NotebookEdit/)) {
                touchedFiles.push(`${input.tool_name}:${path}`);
              }
              return {};
            },
          ],
        },
      ],
    },
  },
});

let result: SDKResultMessage | undefined;
for await (const msg of q) {
  if (msg.type === "result") result = msg as SDKResultMessage;
}

clearTimeout(timer);

if (!result) {
  console.error("❌ 没收到 result 消息");
  process.exit(1);
}

const r = result as SDKResultMessage;
console.log("✅ query 完成");
console.log("  subtype:    ", r.subtype);
console.log("  is_error:   ", r.is_error);
console.log("  num_turns:  ", r.num_turns);
console.log("  cost_usd:   ", r.total_cost_usd?.toFixed(6));
console.log("  session_id: ", r.session_id);
console.log("  stop_reason:", r.stop_reason);
console.log("  hooks 观察到的写入工具调用数:", turns);
console.log("  hooks 观察到的文件改动:", touchedFiles);
console.log("  result 文本前 200 字:", (r.subtype === "success" ? r.result : r.errors.join("; "))?.slice(0, 200));
