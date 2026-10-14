import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext, type SimpleStreamOptions, type Model, type Api } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ScriptedReply = { tool: string; arguments: Record<string, unknown> } | { text: string };
export function registerScriptedSupervisor(runtime: ModelRuntime, script: (context: TranscriptContext, request: number) => ScriptedReply | Promise<ScriptedReply>, onError?: (error: Error) => void): { model: Model<Api>; requests: TranscriptContext[]; errors: Error[] } {
  const requests: TranscriptContext[] = [];
  const errors: Error[] = [];
  runtime.registerProvider("offline-scripted", {
    api: "offline-scripted-api", apiKey: "offline-not-a-credential", baseUrl: "https://invalid.invalid",
    models: [{ id: "supervisor", name: "Offline scripted supervisor", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context, options?: SimpleStreamOptions) => {
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "pending", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          await options?.onPayload?.({ offline: true }, model);
          if (options?.signal?.aborted) throw new Error("scripted_aborted");
          requests.push(structuredClone(context));
          const reply = await script(context, requests.length);
          stream.push({ type: "start", partial: output });
          if ("tool" in reply) {
            const call = { type: "toolCall" as const, id: `offline-call-${requests.length}`, name: reply.tool, arguments: {} };
            output.content.push(call); stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
            call.arguments = reply.arguments;
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(reply.arguments), partial: output });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output }); output.stopReason = "toolUse";
          } else {
            const block = { type: "text" as const, text: "" }; output.content.push(block);
            stream.push({ type: "text_start", contentIndex: 0, partial: output }); block.text = reply.text;
            stream.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial: output });
            stream.push({ type: "text_end", contentIndex: 0, content: reply.text, partial: output }); output.stopReason = "stop";
          }
          stream.push({ type: "done", reason: output.stopReason, message: output }); stream.end();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error("scripted_error");
          errors.push(failure); onError?.(failure);
          output.stopReason = options?.signal?.aborted ? "aborted" : "error"; output.errorMessage = error instanceof Error ? error.message : "scripted_error";
          stream.push({ type: "error", reason: output.stopReason, error: output }); stream.end();
        }
      })();
      return stream;
    },
  });
  const model = runtime.getModel("offline-scripted", "supervisor");
  if (!model) throw new Error("offline_model_missing");
  return { model, requests, errors };
}

/** Select only a result after its exact emitted assistant call; trailing native wakes are untouched. */
export function findScriptedToolResult(messages: TranscriptContext["messages"], toolCallId: string, name: string) {
  const call = messages.findIndex(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall" && block.id === toolCallId && block.name === name));
  if (call < 0) throw new Error("scripted_matching_call_missing");
  const result = messages.slice(call + 1).find(message => message.role === "toolResult" && message.toolCallId === toolCallId && message.toolName === name);
  if (!result || result.role !== "toolResult") throw new Error("scripted_matching_result_missing");
  return result;
}
