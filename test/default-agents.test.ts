import { describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import { DEFAULT_REVIEWER_MODEL } from "../src/model-routing.js";

describe("read-only specialist defaults", () => {
  it("keeps Plan and Explore read-only, disables extensions, and routes Plan through Sol", () => {
    const plan = DEFAULT_AGENTS.get("Plan");
    const explore = DEFAULT_AGENTS.get("Explore");

    expect(plan?.builtinToolNames).not.toContain("bash");
    expect(plan?.builtinToolNames).not.toContain("write");
    expect(plan?.builtinToolNames).not.toContain("edit");
    expect(plan?.extensions).toBe(false);
    expect(plan?.model).toBe(DEFAULT_REVIEWER_MODEL);
    expect(plan?.thinking).toBe("high");
    expect(plan?.persistSession).toBe(true);
    expect(plan?.systemPrompt).not.toMatch(/\bbash\b/i);

    expect(explore?.builtinToolNames).not.toContain("bash");
    expect(explore?.builtinToolNames).not.toContain("write");
    expect(explore?.builtinToolNames).not.toContain("edit");
    expect(explore?.extensions).toBe(false);
    expect(explore?.systemPrompt).not.toMatch(/\bbash\b/i);
  });
});
