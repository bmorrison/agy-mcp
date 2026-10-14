import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fail } from "./contracts.js";
import { providerDiagnostic, type AgyProvider } from "./provider.js";

const identity = Type.String({ minLength: 1, maxLength: 4096 });
const target = { runId: identity, index: Type.Optional(Type.Integer({ minimum: 0 })) };
export const ControlParameters = Type.Union([
  Type.Object({ action: Type.Literal("status"), ...target }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("cancel"), ...target }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("queue"), ...target, messageId: identity, message: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false }),
]);
const Identity = Type.Object({ runId: identity, index: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const Receipt = Type.Object({ sequence: Type.Integer({ minimum: 1 }), messageId: identity, contentDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }), state: Type.Union([Type.Literal("queued"), Type.Literal("forwarded"), Type.Literal("dispatch_unknown"), Type.Literal("not_delivered")]) }, { additionalProperties: false });
const nullableString = Type.Union([Type.String(), Type.Null()]);
export const ControlOutput = Type.Union([
  Type.Object({ ok: Type.Literal(false), errorCode: Type.String() }, { additionalProperties: false }),
  Type.Object({
    ok: Type.Literal(true), requested: Identity, latest: Identity,
    status: Type.Object({ assignmentId: identity, latestJobId: identity, runId: identity, stepIndex: Type.Integer({ minimum: 0 }), phase: Type.Union([Type.Literal("claimed"), Type.Literal("dispatching"), Type.Literal("acknowledged"), Type.Literal("dispatch_unknown"), Type.Literal("terminal")]), semanticState: Type.Union([Type.Literal("running"), Type.Literal("waiting_for_supervisor"), Type.Literal("blocked"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("execution_unknown")]), conversationAvailable: Type.Boolean(), errorCode: nullableString, evidence: Type.Object({ backendStatus: nullableString, exitCode: Type.Union([Type.Integer(), Type.Null()]), cancelSignalled: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), receipts: Type.Array(Receipt) }, { additionalProperties: false }),
    receipt: Type.Optional(Receipt), cancellation: Type.Optional(Type.Object({ signalled: Type.Union([Type.Boolean(), Type.Null()]), terminalCorrelated: Type.Boolean(), errorCode: nullableString }, { additionalProperties: false })),
  }, { additionalProperties: false }),
]);
export function createControlTool(current: () => AgyProvider | undefined): ToolDefinition<typeof ControlParameters, Static<typeof ControlOutput>> {
  return {
    name: "agy_subagent_control", label: "AGY subagent control",
    description: "Status, persist queued guidance for an explicit future resume, or explicitly cancel an exact locally-owned active AGY turn. Queue does not wake, resume or launch. Native launch/reply remain subagent.",
    parameters: ControlParameters, outputSchema: ControlOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async execute(_id, params, signal, _update, ctx) {
      try {
        // Also validate direct trusted SDK invocations; never accept action-inapplicable knobs.
        const allowed = params.action === "queue" ? ["action", "runId", "index", "message", "messageId"] : ["action", "runId", "index"];
        if (Object.keys(params).some(key => !allowed.includes(key)) || !["status", "queue", "cancel"].includes(params.action)) fail("invalid_control_arguments");
        const provider = current(); if (!provider) fail("provider_not_ready");
        const result = await provider.control(params, ctx.sessionManager.getSessionId(), signal);
        const data = { ok: true as const, ...result, status: { ...result.status, receipts: [...result.status.receipts] } };
        return { content: [{ type: "text", text: JSON.stringify(data) }], details: data, structuredContent: JSON.parse(JSON.stringify(data)) };
      } catch (error) {
        const data = { ok: false as const, errorCode: providerDiagnostic(error) };
        return { isError: true, content: [{ type: "text", text: data.errorCode }], details: data, structuredContent: data };
      }
    },
  };
}
