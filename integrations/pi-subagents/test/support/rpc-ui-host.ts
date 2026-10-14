import { randomUUID } from "node:crypto";
import { Theme, type ExtensionUIContext, type ExtensionUIDialogOptions, type RpcExtensionUIRequest, type RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

/** Offscreen RPC client: dialogs require correlated client responses; presentation is inspectable state. */
export class RpcUiHost {
  readonly requests: RpcExtensionUIRequest[] = [];
  readonly notifications: { message: string; type: string }[] = [];
  readonly statuses = new Map<string, string>();
  readonly widgets = new Map<string, { lines: string[]; placement: string }>();
  title = "";
  editorText = "";
  private pending = new Map<string, { request: RpcExtensionUIRequest; finish: (value: string | boolean | undefined) => void }>();
  readonly uiContext: ExtensionUIContext;

  constructor(theme: Theme, private readonly client?: (request: RpcExtensionUIRequest, host: RpcUiHost) => void) {
    const send = (request: RpcExtensionUIRequest) => { this.requests.push(request); this.client?.(request, this); };
    const dialog = (request: RpcExtensionUIRequest, opts?: ExtensionUIDialogOptions) => new Promise<string | boolean | undefined>(resolve => {
      let timer: NodeJS.Timeout | undefined;
      const abort = () => finish(undefined);
      const finish = (value: string | boolean | undefined) => {
        this.pending.delete(request.id); clearTimeout(timer); opts?.signal?.removeEventListener("abort", abort); resolve(value);
      };
      if (opts?.signal?.aborted) { resolve(undefined); return; }
      this.pending.set(request.id, { request, finish });
      opts?.signal?.addEventListener("abort", abort, { once: true });
      if (opts?.timeout !== undefined) timer = setTimeout(abort, opts.timeout);
      send(request);
    });
    const id = () => randomUUID();
    const timeout = (opts?: ExtensionUIDialogOptions) => opts?.timeout === undefined ? {} : { timeout: opts.timeout };
    const value = async (promise: Promise<string | boolean | undefined>) => { const result = await promise; return typeof result === "string" ? result : undefined; };
    this.uiContext = {
      select: (title, options, opts) => value(dialog({ type: "extension_ui_request", id: id(), method: "select", title, options: [...options], ...timeout(opts) }, opts)),
      confirm: async (title, message, opts) => (await dialog({ type: "extension_ui_request", id: id(), method: "confirm", title, message, ...timeout(opts) }, opts)) === true,
      input: (title, placeholder, opts) => value(dialog({ type: "extension_ui_request", id: id(), method: "input", title, placeholder, ...timeout(opts) }, opts)),
      editor: (title, prefill) => value(dialog({ type: "extension_ui_request", id: id(), method: "editor", title, prefill })),
      notify: (message, type = "info") => { this.notifications.push({ message, type }); send({ type: "extension_ui_request", id: id(), method: "notify", message, notifyType: type }); },
      setStatus: (key, text) => { if (text === undefined) this.statuses.delete(key); else this.statuses.set(key, text); send({ type: "extension_ui_request", id: id(), method: "setStatus", statusKey: key, statusText: text }); },
      setWidget: (key, content, opts) => { if (typeof content === "function") return; if (content === undefined) this.widgets.delete(key); else this.widgets.set(key, { lines: [...content], placement: opts?.placement ?? "aboveEditor" }); send({ type: "extension_ui_request", id: id(), method: "setWidget", widgetKey: key, widgetLines: content, widgetPlacement: opts?.placement }); },
      setTitle: title => { this.title = title; send({ type: "extension_ui_request", id: id(), method: "setTitle", title }); },
      setEditorText: text => { this.editorText = text; send({ type: "extension_ui_request", id: id(), method: "set_editor_text", text }); },
      pasteToEditor: text => this.uiContext.setEditorText(text),
      theme,
      // Documented RPC terminal-only degradation (docs/rpc-extension-ui.md).
      custom: async <T>() => undefined as T, onTerminalInput: () => () => {},
      setWorkingMessage: () => {}, setWorkingVisible: () => {}, setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {},
      setFooter: () => {}, setHeader: () => {}, addAutocompleteProvider: () => {}, setEditorComponent: () => {}, setToolsExpanded: () => {},
      getEditorText: () => "", getEditorComponent: () => undefined, getToolsExpanded: () => false,
      getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: false, error: "Theme switching not supported in RPC mode" }),
    };
  }

  respond(response: RpcExtensionUIResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    if ("cancelled" in response) { pending.finish(undefined); return true; }
    if (pending.request.method === "confirm") {
      if (!("confirmed" in response)) return false;
      pending.finish(response.confirmed); return true;
    }
    if (!("value" in response)) return false;
    if (pending.request.method === "select" && !pending.request.options.includes(response.value)) return false;
    pending.finish(response.value); return true;
  }

  dispose(): void { for (const pending of this.pending.values()) pending.finish(undefined); }
}

export function rpcHostTheme(): Theme {
  return new Theme(
    { accent: "#dddddd", border: "#dddddd", borderAccent: "#dddddd", borderMuted: "#dddddd", success: "#dddddd", error: "#dddddd", warning: "#dddddd", muted: "#dddddd", dim: "#dddddd", text: "#dddddd", thinkingText: "#dddddd", scrollbarTrack: "#dddddd", scrollbarThumb: "#dddddd", searchMatchText: "#dddddd", userMessageText: "#dddddd", customMessageText: "#dddddd", customMessageLabel: "#dddddd", toolTitle: "#dddddd", toolOutput: "#dddddd", mdHeading: "#dddddd", mdLink: "#dddddd", mdLinkUrl: "#dddddd", mdCode: "#dddddd", mdCodeBlock: "#dddddd", mdCodeBlockBorder: "#dddddd", mdQuote: "#dddddd", mdQuoteBorder: "#dddddd", mdHr: "#dddddd", mdListBullet: "#dddddd", toolDiffAdded: "#dddddd", toolDiffRemoved: "#dddddd", toolDiffContext: "#dddddd", syntaxComment: "#dddddd", syntaxKeyword: "#dddddd", syntaxFunction: "#dddddd", syntaxVariable: "#dddddd", syntaxString: "#dddddd", syntaxNumber: "#dddddd", syntaxType: "#dddddd", syntaxOperator: "#dddddd", syntaxPunctuation: "#dddddd", thinkingOff: "#dddddd", thinkingMinimal: "#dddddd", thinkingLow: "#dddddd", thinkingMedium: "#dddddd", thinkingHigh: "#dddddd", thinkingXhigh: "#dddddd", thinkingMax: "#dddddd", bashMode: "#dddddd" },
    { selectedBg: "#111111", searchMatchBg: "#111111", userMessageBg: "#111111", customMessageBg: "#111111", toolPendingBg: "#111111", toolSuccessBg: "#111111", toolErrorBg: "#111111" },
    "truecolor", { name: "offline-rpc", appearance: "dark" },
  );
}
