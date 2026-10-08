import type { AgentRecord } from "../types.js";
import type { MessageUsageDelta } from "../usage.js";
import type { WorkflowUsageEvent } from "./artifacts.js";

function modelParts(record: AgentRecord): { provider: string | null; model: string | null } {
  const id = record.selectedModelId ?? record.invocation?.modelId;
  const slash = id?.indexOf("/") ?? -1;
  return slash > 0
    ? { provider: id!.slice(0, slash), model: id!.slice(slash + 1) }
    : { provider: null, model: null };
}

export function workflowUsageEvent(
  record: AgentRecord,
  observed?: MessageUsageDelta,
): WorkflowUsageEvent | undefined {
  if (record.workflowId === undefined) return undefined;
  return {
    event: "usage",
    workflowId: record.workflowId,
    agentId: record.id,
    role: record.type,
    ...modelParts(record),
    requestedThinking: record.requestedThinking ?? null,
    effectiveThinking: record.invocation?.thinking ?? null,
    input: observed?.input ?? null,
    output: observed?.output ?? null,
    cacheRead: observed?.cacheRead ?? null,
    cacheWrite: observed?.cacheWrite ?? null,
    costUsd: observed?.cost ?? null,
    attempt: Math.max(1, record.providerAttempts ?? 0),
    status: null,
    durationMs: null,
  };
}

export function workflowCompletionEvent(record: AgentRecord): WorkflowUsageEvent | undefined {
  if (record.workflowId === undefined) return undefined;
  return {
    event: "complete",
    workflowId: record.workflowId,
    agentId: record.id,
    role: record.type,
    ...modelParts(record),
    requestedThinking: record.requestedThinking ?? null,
    effectiveThinking: record.invocation?.thinking ?? null,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    costUsd: null,
    attempt: Math.max(0, record.providerAttempts ?? 0),
    status: record.status,
    durationMs: Math.max(0, (record.completedAt ?? Date.now()) - record.startedAt),
  };
}
