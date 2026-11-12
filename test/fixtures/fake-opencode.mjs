#!/usr/bin/env node
// Hermetic stand-in for the `opencode` CLI. Behavior selected by FAKE_MODE.
// Records argv/cwd/env-keys to ARGV_FILE when set so tests can assert the spawn contract.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_MODE ?? "success";
if (process.env.ARGV_FILE) {
  writeFileSync(process.env.ARGV_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env).sort() }));
}
const model = process.env.FAKE_MODEL ?? "opencode/deepseek-v4.1-flash-free";
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const step = () => emit({ type: "step_start", sessionID: "ses_1", part: {} });
const finish = (tokens = { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } }, cost = 0.01) =>
  emit({ type: "step_finish", sessionID: "ses_1", modelID: model, part: { tokens, cost } });
const spawnSleeper = (detached = false) => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    stdio: "inherit",
    detached,
  });
  if (process.env.CHILD_PIDFILE) writeFileSync(process.env.CHILD_PIDFILE, String(child.pid));
};

switch (mode) {
  case "success":
    step();
    emit({ type: "text", sessionID: "ses_1", modelID: model, part: { text: "Hello " } });
    emit({ type: "text", sessionID: "ses_1", modelID: model, part: { text: "world" } });
    emit({ type: "tool", sessionID: "ses_1", modelID: model, part: { tool: "bash", state: "completed" } });
    finish();
    step();
    finish({ input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, 0.002);
    process.exit(0);
    break;
  case "missing-usage":
    step();
    emit({ type: "text", sessionID: "ses_1", part: { text: "ok" } });
    process.exit(0);
    break;
  case "missing-text":
    step();
    finish();
    process.exit(0);
    break;
  case "malformed":
    step();
    process.stdout.write("{not json\n");
    process.exit(0);
    break;
  case "malformed-envelope":
    process.stdout.write("[]\n");
    process.exit(0);
    break;
  case "missing-type":
    process.stdout.write("{}\n");
    process.exit(0);
    break;
  case "null-envelope":
    process.stdout.write("null\n", () => process.exit(0));
    break;
  case "malformed-part":
    process.stdout.write(`${JSON.stringify({ type: "text", part: [] })}\n`, () => process.exit(0));
    break;
  case "stdout-flood":
    process.stdout.write(`${JSON.stringify({ type: "step_start", sessionID: "ses_1", part: {} })}\n`);
    process.stdout.write(
      `${JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "x".repeat(512) } })}\n`.repeat(2100),
      () => process.exit(0),
    );
    break;
  case "error-event":
    emit({
      type: "error",
      sessionID: "ses_1",
      error: { type: "provider.rate-limit", name: "APIError", message: "The inference service is overloaded. Please try again later.", status: 429 },
    });
    process.exit(1);
    break;
  case "error-event-bare":
    emit({ type: "error", sessionID: "ses_1" });
    process.exit(1);
    break;
  case "wrong-model":
    emit({ type: "text", sessionID: "ses_1", modelID: "other/model", part: { text: "x" } });
    process.exit(0);
    break;
  case "nonzero":
    process.stderr.write("boom from fake\n");
    process.exit(3);
    break;
  case "long-line":
    // Unterminated 300 KiB line; exit only after flush so the runner sees the full bytes.
    process.stdout.write(`{"type":"text","part":{"text":"${"x".repeat(300 * 1024)}"}}\n`, () => process.exit(0));
    break;
  case "huge-text":
    process.stdout.write(Array.from({ length: 20 }, () => JSON.stringify({ type: "text", part: { text: "y".repeat(8 * 1024) } }) + "\n").join(""), () => process.exit(0));
    break;
  case "stderr-flood":
    process.stderr.write("e".repeat(2 * 1024 * 1024), () => process.exit(1));
    break;
  case "hang":
    step();
    setInterval(() => {}, 1000);
    break;
  case "leader-exit-in-group-child":
    spawnSleeper();
    // Let the in-group sleeper install its SIGTERM handler and inherit the stdio pipes.
    await new Promise((resolve) => setTimeout(resolve, 200));
    step();
    emit({ type: "text", sessionID: "ses_1", part: { text: "partial" } });
    process.exit(0);
    break;
  case "leader-exit-with-child":
    spawnSleeper(true);
    // Let the detached sleeper install its SIGTERM handler and inherit the stdio pipes.
    await new Promise((resolve) => setTimeout(resolve, 200));
    step();
    emit({ type: "text", sessionID: "ses_1", part: { text: "partial" } });
    process.exit(0);
    break;
  case "sigterm-resistant":
    spawnSleeper();
    process.on("SIGTERM", () => {});
    step();
    setInterval(() => {}, 1000);
    break;
  default:
    process.stderr.write(`unknown FAKE_MODE ${mode}\n`);
    process.exit(2);
}
