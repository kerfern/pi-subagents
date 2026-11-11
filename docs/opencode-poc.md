# Experimental OpenCode task delegation

This experimental parent-only `opencode_task` tool delegates one self-contained prompt through the official `opencode run` CLI, fixed to `opencode/deepseek-v4.1-flash-free`. It is not a provider, proxy, route, or free-tier gate bypass. No model, cwd, executable, argv, tool, attachment, or resume options are exposed.

Each call requires trusted project context, an interactive TUI, and explicit per-call confirmation. The approval shows full prompt, model, cwd, and warns that OpenCode's separate runtime can use tools and read/write cwd. Pi child tool scope, transcript, resume, and steering do not apply. Child sessions cannot register or execute this tool.

The child runs `opencode --standalone run --model opencode/deepseek-v4.1-flash-free --format json --archived 'Task:\n<prompt>'` without a shell, with stdin ignored and output piped. `--standalone` uses a private OpenCode server so a wedged shared service cannot block the task; each invocation pays private-server startup cost. It does not make session storage private: OpenCode still writes its normal session store, and `--archived` only hides the session; it does not delete it. Only PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, TMP, TEMP, LANG, LC_ALL, plus `XDG_*`, `OPENCODE_*`, and `PI_OPENCODE_*` variables are passed. OpenCode may still load project config, plugins, or MCP servers from cwd; this is a residual risk.

This is **not a sandbox**. OpenCode tools may change files in cwd; terminating process group cannot undo writes. A descendant that escapes the process group is not contained; if it holds stdio open, the runner rejects after the kill grace instead of hanging. Execution is bounded; the runner kills the whole process group on timeout, abort, or any bound violation (SIGTERM, then SIGKILL after 1 second). Windows is unsupported. Output is bounded (120 seconds, 16 KiB prompt, 256 KiB line, 1 MiB stdout, 16 KiB stderr, 64 KiB final text); errors fail closed without fallback or retry. Usage is reported only when present in CLI events; it is not Pi model usage.

The extension module is not added to package defaults or routing. Load it explicitly with `pi -e ./src/opencode-poc.ts`; review its access implications first.

## Usage

Start Pi from the directory the task should run in, with the experimental extension loaded:

```bash
cd /Users/kerf/Projects/pi-subagents
pi -e ./src/opencode-poc.ts
```

`opencode_task` is available in the **main/parent session**. It is not available in subagents and cannot be selected with `/subagent-model`. Each call needs a trusted project, an interactive TUI, and approval showing the prompt, cwd, and model.

Ask the parent model for one self-contained task:

```text
Use opencode_task for this read-only investigation:
"Inspect src/foo.ts and its tests. Return exact failure causes with
file:line, a proposed patch, and verification commands. Do not modify files."
```

"Read-only" is prompt-level, not enforced: OpenCode may still use its own tools and change cwd. Review `git diff` after the call.

## Orchestration with subagents

Use the parent as the orchestrator:

```text
Parent Pi session
  ├─ Plan subagent        → split work and define acceptance
  ├─ worker(s)            → normal Pi-routed work
  ├─ opencode_task        → one self-contained free-model task
  ├─ reviewer subagent    → review output/diff
  └─ parent               → verify and decide
```

The parent can use `Agent`, `Plan`, `worker`, `reviewer`, and `SubagentWorkflow` normally. The free-model task is one more bounded tool call by the parent.

What does not work:

- A subagent calling `opencode_task`: the tool is absent in child sessions and execute rejects child context.
- A workflow script calling `opencode_task`: workflows can spawn agents, not arbitrary parent tools.
- Selecting the free model with `/subagent-model`: not supported; keep subagents on Pi-routed models.

For risky tasks, start Pi in a disposable worktree or copy because `opencode_task` has no cwd override.

## What this does not do

- **No tool-call bridge.** OpenCode executes its own tools. Tool events are observations only; Pi tools, `tool_choice`, and unexecuted `tool_calls` are never forwarded.
- **No Pi child model route.** This is not `/subagent-model`. Pi child tool scope, permissions, transcript, steering, and resume do not apply.
- **No fabricated telemetry.** Text updates and usage come only from OpenCode's JSONL events; missing measurements stay unknown. Streaming is OpenCode's event stream, not invented chunks.
- **No fallback.** This is not an attempt to add a caller-owned tool-call API. When OpenCode does not provide one, the tool remains a whole-task delegation boundary and fails closed on unexpected output.
