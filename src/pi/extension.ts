import { Type } from "@sinclair/typebox";
import { RelayRuntime } from "../core/runtime.js";
import type { PeerInfo, RelayPromptEvent, RelayResponseEvent } from "../core/types.js";

type PiApi = {
  registerFlag: (name: string, options: Record<string, unknown>) => void;
  getFlag: (name: string) => unknown;
  registerTool: (definition: Record<string, unknown>) => void;
  registerCommand: (name: string, definition: Record<string, unknown>) => void;
  on: (event: string, handler: (...args: any[]) => unknown) => void;
  sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => void;
  appendEntry?: (customType: string, data?: unknown) => void;
};

type PiContext = {
  cwd?: string;
  model?: { id?: string };
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, value: string | undefined) => void;
  };
  getContextUsage?: () => { percent?: number } | undefined;
};

const relayListParams = Type.Object({
  project: Type.Optional(Type.String({ description: "Project name, or \"*\" for all projects. Defaults to this agent's project." })),
  include_explicit: Type.Optional(Type.Boolean({ description: "Include peers started with --relay-explicit. Default false." })),
});

const relaySendParams = Type.Object({
  target: Type.String({ description: "Peer name, or session_id." }),
  prompt: Type.String({ description: "Message/prompt to send to the peer." }),
  parent_msg_id: Type.Optional(Type.String({ description: "Inbound Relay msg_id this send delegates from. The runtime uses this to compute hops." })),
  conversation_id: Type.Optional(Type.String({ description: "Optional conversation/thread correlation id." })),
  response_schema: Type.Optional(Type.Any({ description: "Optional JSON schema describing the expected response." })),
});

const relayReplyParams = Type.Object({
  msg_id: Type.String({ description: "Inbound prompt msg_id being answered." }),
  response: Type.Any({ description: "String or JSON value to send as the response." }),
  error: Type.Optional(Type.String({ description: "Optional error string if the request failed." })),
});

export default function hearsayRelayPiExtension(pi: PiApi) {
  pi.registerFlag("relay-name", {
    description: "Hearsay Relay peer name. Defaults to agent-<id>.",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("relay-project", {
    description: "Hearsay Relay project namespace for peer discovery.",
    type: "string",
    default: "default",
  });
  pi.registerFlag("relay-purpose", {
    description: "Short description shown to Relay peers.",
    type: "string",
    default: "",
  });
  pi.registerFlag("relay-color", {
    description: "Hex color #RRGGBB shown to Relay peers.",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("relay-explicit", {
    description: "Hide this peer from normal relay_list unless include_explicit=true.",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("relay-dir", {
    description: "Override Hearsay Relay storage directory. Defaults to HEARSAY_RELAY_DIR or ~/.hearsay/relay.",
    type: "string",
    default: undefined,
  });

  let runtime: RelayRuntime | null = null;
  let currentCtx: PiContext | null = null;

  pi.registerTool({
    name: "relay_list",
    label: "Relay List",
    description: "List Hearsay Relay peers. Use project=\"*\" to scan all projects. include_explicit=true reveals explicit peers.",
    promptSnippet: "List Hearsay Relay peer agents available for async messages.",
    parameters: relayListParams,
    async execute(_toolCallId: string, params: { project?: string; include_explicit?: boolean }) {
      const relay = requireRuntime(runtime);
      const peers = await relay.listPeers({
        project: params.project,
        include_explicit: params.include_explicit,
        ping: true,
      });

      return {
        content: [{ type: "text", text: formatPeerList(peers) }],
        details: { agents: peers, project: params.project ?? relay.project },
      };
    },
  });

  pi.registerTool({
    name: "relay_send",
    label: "Relay Send",
    description: "Send an async Hearsay Relay message to a peer. Returns after receiver ACK with {msg_id,status:\"sent\"}; it does not wait for the final response.",
    promptSnippet: "Send an async Hearsay Relay message to another peer; response arrives later as an injected Relay event.",
    promptGuidelines: [
      "Use relay_send for asynchronous Hearsay Relay messages; it returns only after receiver ACK and must not be followed by polling.",
      "When delegating work caused by an inbound Relay prompt, pass that inbound prompt's msg_id as relay_send parent_msg_id.",
    ],
    parameters: relaySendParams,
    async execute(_toolCallId: string, params: {
      target: string;
      prompt: string;
      parent_msg_id?: string;
      conversation_id?: string;
      response_schema?: unknown;
    }) {
      const relay = requireRuntime(runtime);
      const result = await relay.sendPrompt({
        target: params.target,
        prompt: params.prompt,
        parent_msg_id: params.parent_msg_id ?? null,
        conversation_id: params.conversation_id ?? null,
        response_schema: params.response_schema ?? null,
      });

      return {
        content: [{
          type: "text",
          text: [
            `relay_send → ${result.target}`,
            `msg_id: ${result.msg_id}`,
            `status: ${result.status}`,
            `hops: ${result.hops}`,
            "A response event will be injected when the peer explicitly replies.",
          ].join("\n"),
        }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "relay_reply",
    label: "Relay Reply",
    description: "Explicitly reply to an inbound Hearsay Relay prompt by msg_id.",
    promptSnippet: "Reply explicitly to an inbound Hearsay Relay prompt using its msg_id.",
    promptGuidelines: [
      "Use relay_reply to answer every inbound Hearsay Relay prompt once the response is ready.",
      "Do not rely on the final assistant message as a Relay response; call relay_reply explicitly with the intended payload.",
    ],
    parameters: relayReplyParams,
    async execute(_toolCallId: string, params: { msg_id: string; response: unknown; error?: string }) {
      const relay = requireRuntime(runtime);
      const result = await relay.reply({
        msg_id: params.msg_id,
        response: params.response,
        error: params.error ?? null,
      });

      return {
        content: [{ type: "text", text: `relay_reply sent for msg_id ${result.msg_id}` }],
        details: result,
      };
    },
  });

  pi.registerCommand("relay", {
    description: "Show Hearsay Relay identity and peer summary.",
    handler: async (_args: string, ctx: PiContext) => {
      const relay = runtime;
      if (!relay) {
        ctx.ui?.notify?.("Hearsay Relay is not started", "warning");
        return;
      }
      const peers = await relay.listPeers({ ping: true });
      const message = [
        `Relay: ${relay.name}@${relay.project}`,
        `Session: ${relay.sessionId}`,
        `${peers.length} peer(s):`,
        ...peers.map(formatPeerLine),
      ].join("\n");
      ctx.ui?.notify?.(message, "info");
    },
  });

  pi.on("session_start", async (_event: unknown, ctx: PiContext) => {
    currentCtx = ctx;

    if (runtime) {
      await runtime.stop().catch(() => undefined);
      runtime = null;
    }

    const name = getStringFlag(pi, "relay-name") ?? process.env.HEARSAY_RELAY_NAME;
    const project = getStringFlag(pi, "relay-project") ?? process.env.HEARSAY_RELAY_PROJECT ?? "default";
    const purpose = getStringFlag(pi, "relay-purpose") ?? process.env.HEARSAY_RELAY_PURPOSE ?? "";
    const color = getStringFlag(pi, "relay-color") ?? process.env.HEARSAY_RELAY_COLOR;
    const relayDir = getStringFlag(pi, "relay-dir") ?? process.env.HEARSAY_RELAY_DIR;
    const explicit = getBooleanFlag(pi, "relay-explicit") || process.env.HEARSAY_RELAY_EXPLICIT === "1";

    const nextRuntime = new RelayRuntime({
      name,
      project,
      purpose,
      color,
      relayDir,
      explicit,
      cwd: ctx.cwd ?? process.cwd(),
      model: ctx.model?.id ?? "unknown",
      contextUsedPct: () => ctx.getContextUsage?.()?.percent ?? null,
    });

    nextRuntime.on("prompt", (event) => {
      injectPrompt(pi, currentCtx, event);
    });
    nextRuntime.on("response", (event) => {
      injectResponse(pi, currentCtx, event, false);
    });
    nextRuntime.on("orphan_response", (event) => {
      injectResponse(pi, currentCtx, event, true);
    });

    try {
      await nextRuntime.start();
      runtime = nextRuntime;
      ctx.ui?.setStatus?.("hearsay-relay", `📡 ${nextRuntime.name}@${nextRuntime.project}`);
      ctx.ui?.notify?.(`Hearsay Relay ready · ${nextRuntime.name}@${nextRuntime.project}`, "info");
      pi.appendEntry?.("hearsay-relay-log", {
        event: "started",
        name: nextRuntime.name,
        project: nextRuntime.project,
        session_id: nextRuntime.sessionId,
        endpoint: nextRuntime.endpoint,
      });
    } catch (error) {
      await nextRuntime.stop().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui?.setStatus?.("hearsay-relay", "📡 relay failed");
      ctx.ui?.notify?.(`Hearsay Relay failed to start: ${message}`, "error");
      pi.appendEntry?.("hearsay-relay-log", { event: "start_failed", error: message });
    }
  });

  pi.on("session_shutdown", async () => {
    currentCtx?.ui?.setStatus?.("hearsay-relay", undefined);
    currentCtx = null;
    const relay = runtime;
    runtime = null;
    if (relay) await relay.stop();
  });
}

function requireRuntime(runtime: RelayRuntime | null): RelayRuntime {
  if (!runtime) throw new Error("Hearsay Relay is not started");
  return runtime;
}

function injectPrompt(pi: PiApi, ctx: PiContext | null, event: RelayPromptEvent): void {
  if (!ctx) throw new Error("pi context unavailable");

  pi.sendMessage({
    customType: "hearsay-relay",
    content: formatPromptEvent(event),
    display: true,
    details: event,
  }, { deliverAs: "followUp", triggerTurn: true });

  ctx.ui?.notify?.(`Relay prompt from ${event.sender_name}: ${event.msg_id}`, "info");
  pi.appendEntry?.("hearsay-relay-log", {
    event: "inbound_prompt",
    msg_id: event.msg_id,
    sender_name: event.sender_name,
    sender_session: event.sender_session,
    hops: event.hops,
  });
}

function injectResponse(pi: PiApi, ctx: PiContext | null, event: RelayResponseEvent, orphan: boolean): void {
  try {
    pi.sendMessage({
      customType: "hearsay-relay",
      content: formatResponseEvent(event, orphan),
      display: true,
      details: { ...event, orphan },
    }, { deliverAs: "followUp", triggerTurn: true });
  } catch {
    // Response is already recorded in runtime state; do not NACK the peer just
    // because the local UI/session injection failed.
  }

  ctx?.ui?.notify?.(`${orphan ? "Orphan Relay response" : "Relay response"} from ${event.sender_name}: ${event.msg_id}`, orphan ? "warning" : "info");
  pi.appendEntry?.("hearsay-relay-log", {
    event: orphan ? "orphan_response" : "inbound_response",
    msg_id: event.msg_id,
    sender_name: event.sender_name,
    sender_session: event.sender_session,
    error: event.error ?? null,
  });
}

function formatPromptEvent(event: RelayPromptEvent): string {
  return [
    "[Hearsay Relay inbound prompt]",
    `kind: prompt`,
    `msg_id: ${event.msg_id}`,
    `from: ${event.sender_name} (${event.sender_session})`,
    `sender_cwd: ${event.sender_cwd}`,
    `hops: ${event.hops}`,
    `parent_msg_id: ${event.parent_msg_id ?? ""}`,
    `conversation_id: ${event.conversation_id ?? ""}`,
    `expects_json: ${event.expects_json}`,
    "",
    event.prompt,
    "",
    `When ready, answer this Relay prompt by calling relay_reply with msg_id=${event.msg_id}.`,
    `If you delegate work caused by this prompt, call relay_send with parent_msg_id=${event.msg_id}.`,
  ].join("\n");
}

function formatResponseEvent(event: RelayResponseEvent, orphan: boolean): string {
  return [
    orphan ? "[Hearsay Relay orphan response]" : "[Hearsay Relay response]",
    `kind: response`,
    `msg_id: ${event.msg_id}`,
    `from: ${event.sender_name} (${event.sender_session})`,
    `error: ${event.error ?? ""}`,
    "",
    formatUnknown(event.response),
  ].join("\n");
}

function formatPeerList(peers: PeerInfo[]): string {
  if (peers.length === 0) return "0 Relay peer(s).";
  return [`${peers.length} Relay peer(s):`, ...peers.map(formatPeerLine)].join("\n");
}

function formatPeerLine(peer: PeerInfo): string {
  const live = peer.alive ? "●" : "✗";
  const context = peer.agent_card?.context_used_pct == null ? "?%" : `${peer.agent_card.context_used_pct}%`;
  const purpose = peer.purpose ? ` — ${peer.purpose}` : "";
  return `${live} ${peer.name} (${peer.model}) ${context} project=${peer.project} session=${peer.session_id}${purpose}`;
}

function formatUnknown(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function getStringFlag(pi: PiApi, name: string): string | undefined {
  const value = pi.getFlag(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getBooleanFlag(pi: PiApi, name: string): boolean {
  return pi.getFlag(name) === true;
}
