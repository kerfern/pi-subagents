import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Tests must not inherit developer-global pi settings. In particular,
// ~/.pi/agent/subagents.json may disable built-in agents or change fallback
// policy, which makes tests depend on whoever ran them.
const agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-test-agent-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
});
