/**
 * bridge-confirm-probe.ts — CHILD-side extension fixture for the offline
 * approval-bridge end-to-end test.
 *
 * Registers exactly one tool, `bridge_confirm_probe`, whose handler calls
 * `ctx.ui.confirm(...)`. In a child session that call is intercepted by the
 * extension's approval bridge and routed to the ROOT session's dialog; the
 * boolean the root's dialog returns is what the child receives.
 *
 * The handler records two NDJSON rows in `tracePath`: "requested" right after
 * the confirm call is INVOKED (so a test can tell a real request apart from a
 * scripted one) and "end" once it resolves, with the answer the child got.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface ProbeParams {
  label: string;
  title: string;
  message: string;
  tracePath: string;
  timeout?: number;
  abortAfterCall?: boolean;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bridge_confirm_probe",
    label: "Bridge confirm probe",
    description: "Asks for one confirmation through the session UI and reports the answer.",
    parameters: Type.Object({
      label: Type.String({ description: "Identifies this request in the trace." }),
      title: Type.String({ description: "Title passed to the confirmation dialog." }),
      message: Type.String({ description: "Message passed to the confirmation dialog." }),
      tracePath: Type.String({ description: "Absolute path of the NDJSON trace file to append to." }),
      timeout: Type.Optional(Type.Number({ description: "Caller-side timeout in ms." })),
      abortAfterCall: Type.Optional(
        Type.Boolean({ description: "Abort the caller signal right after the confirm call." }),
      ),
    }),
    async execute(
      _id: string,
      params: ProbeParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) {
      const record = (row: Record<string, unknown>) => {
        appendFileSync(params.tracePath, `${JSON.stringify({ label: params.label, ...row })}\n`);
      };

      const options: { timeout?: number; signal?: AbortSignal } = {};
      if (params.timeout !== undefined) options.timeout = params.timeout;
      const controller = params.abortAfterCall ? new AbortController() : undefined;
      if (controller) options.signal = controller.signal;

      // The call under test: in a child this is the bridge facade, in the root
      // it would be the native dialog.
      const startedAt = performance.now();
      const pending = ctx.ui.confirm(params.title, params.message, options);
      record({
        event: "requested",
        title: params.title,
        message: params.message,
        timeout: options.timeout,
        hasUI: ctx.hasUI,
        sessionId: ctx.sessionManager.getSessionId(),
      });
      ctx.ui.notify(`bridge-probe: requested ${params.label}`, "info");
      if (controller) controller.abort();

      const answer = await pending;
      record({
        event: "end",
        answer,
        aborted: options.signal?.aborted === true,
        ms: Math.round(performance.now() - startedAt),
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ label: params.label, answer }) }],
        details: { answer },
      };
    },
  });
}
