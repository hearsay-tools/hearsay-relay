#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { RelayRuntime } from "../core/runtime.js";
import type { PeerInfo, RelayFollowupEvent, RelayPromptEvent, RelayResponseEvent } from "../core/types.js";

interface CliOptions {
  name?: string;
  project: string;
  purpose: string;
  model: string;
  color?: string;
  cwd: string;
  relayDir?: string;
  hidden: boolean;
  maxHops?: number;
}

type ClaudeChannelNotification = {
  method: "notifications/claude/channel";
  params: {
    content: string;
    meta: Record<string, string>;
  };
};

const options = parseCliOptions(process.argv.slice(2));
const runtime = new RelayRuntime({
  name: options.name,
  project: options.project,
  purpose: options.purpose,
  model: options.model,
  color: options.color,
  cwd: options.cwd,
  relayDir: options.relayDir,
  hidden: options.hidden,
  maxHops: options.maxHops,
});

const server = new McpServer(
  {
    name: "hearsay-relay",
    version: "0.0.0",
  },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions: [
      "Hearsay Relay is an asynchronous mailbox/event relay between agents.",
      "Use relay_list_peers to discover peers, relay_send to send async messages, relay_followup to steer existing requests, and relay_reply to explicitly answer inbound Relay prompts.",
      "relay_send returns after receiver ACK only; do not poll or wait for a response tool. Responses arrive later as Claude channel notifications.",
      "relay_followup requires parent_msg_id from an earlier relay_send and does not create a response event or reply obligation.",
      "When delegating work caused by an inbound Relay prompt, pass that inbound prompt's msg_id as relay_send parent_msg_id.",
      "Every inbound Relay prompt should be answered exactly once with relay_reply when ready.",
      "Inbound Relay follow-up events should not be answered with relay_reply; continue the original prompt and reply to that prompt when ready.",
    ].join("\n"),
  },
);

let channelTransportReady = false;
let shuttingDown = false;
const queuedNotifications: ClaudeChannelNotification[] = [];

server.server.oninitialized = () => {
  channelTransportReady = true;
  void flushNotifications();
};

server.server.onerror = (error) => {
  console.error(`[hearsay-relay] MCP error: ${error.message}`);
};

server.server.onclose = () => {
  if (shuttingDown) return;
  void shutdown().finally(() => process.exit(0));
};

server.registerTool(
  "relay_list_peers",
  {
    title: "List Relay Peers",
    description: "List Hearsay Relay peers. Use project=\"*\" to scan all projects. include_hidden=true reveals hidden peers.",
    inputSchema: {
      project: z.string().optional().describe("Project name, or '*' for all projects. Defaults to this Claude peer's project."),
      include_hidden: z.boolean().optional().describe("Include peers started as hidden. Default false."),
    },
  },
  async ({ project, include_hidden }) => {
    const peers = await runtime.listPeers({
      project,
      include_hidden,
      ping: true,
    });

    return {
      content: [{ type: "text" as const, text: formatPeerList(peers) }],
      structuredContent: { agents: peers, project: project ?? runtime.project },
    };
  },
);

server.registerTool(
  "relay_send",
  {
    title: "Send Relay Message",
    description: "Send an async Hearsay Relay message to a peer. Returns after receiver ACK with {msg_id,status:'sent'}; it does not wait for the final response.",
    inputSchema: {
      target: z.string().describe("Peer name, or session_id."),
      prompt: z.string().describe("Message/prompt to send to the peer."),
      parent_msg_id: z.string().optional().describe("Inbound Relay msg_id this send delegates from. The runtime uses it to compute hops."),
      conversation_id: z.string().optional().describe("Optional conversation/thread correlation id."),
      response_schema: z.unknown().optional().describe("Optional JSON schema describing the expected response."),
    },
  },
  async ({ target, prompt, parent_msg_id, conversation_id, response_schema }) => {
    const result = await runtime.sendPrompt({
      target,
      prompt,
      parent_msg_id: parent_msg_id ?? null,
      conversation_id: conversation_id ?? null,
      response_schema: response_schema ?? null,
    });

    return {
      content: [{
        type: "text" as const,
        text: [
          `relay_send → ${result.target}`,
          `msg_id: ${result.msg_id}`,
          `status: ${result.status}`,
          `hops: ${result.hops}`,
          "A response event will be delivered when the peer explicitly replies.",
        ].join("\n"),
      }],
      structuredContent: { ...result },
    };
  },
);

server.registerTool(
  "relay_followup",
  {
    title: "Send Relay Follow-Up",
    description: "Send follow-up steering/context for an existing Relay request. Requires parent_msg_id from an earlier relay_send and does not create a reply obligation.",
    inputSchema: {
      target: z.string().describe("Peer name, or session_id. Must match the original relay_send target."),
      parent_msg_id: z.string().describe("Outbound Relay msg_id from the original relay_send being steered."),
      message: z.string().describe("Follow-up steering/context message. No reply is required for this follow-up."),
    },
  },
  async ({ target, parent_msg_id, message }) => {
    const result = await runtime.followup({ target, parent_msg_id, message });

    return {
      content: [{
        type: "text" as const,
        text: [
          `relay_followup → ${result.target}`,
          `msg_id: ${result.msg_id}`,
          `parent_msg_id: ${result.parent_msg_id}`,
          `status: ${result.status}`,
          `hops: ${result.hops}`,
          "No response event will be delivered for this follow-up.",
        ].join("\n"),
      }],
      structuredContent: { ...result },
    };
  },
);

server.registerTool(
  "relay_reply",
  {
    title: "Reply to Relay Prompt",
    description: "Explicitly reply to an inbound Hearsay Relay prompt by msg_id.",
    inputSchema: {
      msg_id: z.string().describe("Inbound prompt msg_id being answered."),
      response: z.unknown().describe("String or JSON value to send as the response."),
      error: z.string().optional().describe("Optional error string if the request failed."),
    },
  },
  async ({ msg_id, response, error }) => {
    const result = await runtime.reply({
      msg_id,
      response,
      error: error ?? null,
    });

    return {
      content: [{ type: "text" as const, text: `relay_reply sent for msg_id ${result.msg_id}` }],
      structuredContent: { ...result },
    };
  },
);

runtime.on("prompt", (event) => {
  void notifyClaude(formatPromptEvent(event), {
    relay: "hearsay-relay",
    kind: "prompt",
    msg_id: event.msg_id,
    sender_name: event.sender_name,
    sender_session: event.sender_session,
    sender_cwd: event.sender_cwd,
    hops: event.hops,
    parent_msg_id: event.parent_msg_id ?? null,
    conversation_id: event.conversation_id ?? null,
    expects_json: event.expects_json,
  });
});

runtime.on("followup", (event) => {
  void notifyClaude(formatFollowupEvent(event), {
    relay: "hearsay-relay",
    kind: "followup",
    msg_id: event.msg_id,
    parent_msg_id: event.parent_msg_id,
    sender_name: event.sender_name,
    sender_session: event.sender_session,
    sender_cwd: event.sender_cwd,
    hops: event.hops,
    conversation_id: event.conversation_id ?? null,
  });
});

runtime.on("response", (event) => {
  void notifyClaude(formatResponseEvent(event, false), {
    relay: "hearsay-relay",
    kind: "response",
    msg_id: event.msg_id,
    sender_name: event.sender_name,
    sender_session: event.sender_session,
    error: event.error ?? null,
    orphan: false,
  });
});

runtime.on("orphan_response", (event) => {
  void notifyClaude(formatResponseEvent(event, true), {
    relay: "hearsay-relay",
    kind: "response",
    msg_id: event.msg_id,
    sender_name: event.sender_name,
    sender_session: event.sender_session,
    error: event.error ?? null,
    orphan: true,
  });
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Claude Code's channel docs start the outside listener only after stdio is
  // connected. Do the same: once this process is an MCP server, publish our
  // Relay registry entry so peers can send events.
  channelTransportReady = true;
  await flushNotifications();

  await runtime.start();
  console.error(`[hearsay-relay] ready ${runtime.name}@${runtime.project} session=${runtime.sessionId}`);
}

async function notifyClaude(content: string, meta: Record<string, unknown>): Promise<void> {
  const notification: ClaudeChannelNotification = {
    method: "notifications/claude/channel",
    params: { content, meta: normalizeChannelMeta(meta) },
  };

  if (!channelTransportReady) {
    queuedNotifications.push(notification);
    return;
  }

  await sendClaudeChannelNotification(notification);
}

async function flushNotifications(): Promise<void> {
  while (queuedNotifications.length > 0) {
    const notification = queuedNotifications.shift();
    if (!notification) continue;
    await sendClaudeChannelNotification(notification).catch((error: unknown) => {
      console.error(`[hearsay-relay] failed to flush Claude channel notification: ${formatError(error)}`);
    });
  }
}

async function sendClaudeChannelNotification(notification: ClaudeChannelNotification): Promise<void> {
  await server.server.notification(notification as any);
  console.error(`[hearsay-relay] sent Claude channel notification kind=${notification.params.meta.kind ?? ""} msg_id=${notification.params.meta.msg_id ?? ""}`);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  channelTransportReady = false;
  await Promise.allSettled([
    runtime.stop(),
    server.close(),
  ]);
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(143));
});
process.once("SIGHUP", () => {
  void shutdown().finally(() => process.exit(129));
});

main().catch(async (error: unknown) => {
  console.error(`[hearsay-relay] fatal: ${formatError(error)}`);
  await shutdown();
  process.exit(1);
});

function formatPromptEvent(event: RelayPromptEvent): string {
  return [
    "[Hearsay Relay inbound prompt]",
    "kind: prompt",
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

function formatFollowupEvent(event: RelayFollowupEvent): string {
  return [
    "[Hearsay Relay follow-up]",
    "kind: followup",
    `msg_id: ${event.msg_id}`,
    `parent_msg_id: ${event.parent_msg_id}`,
    `from: ${event.sender_name} (${event.sender_session})`,
    `sender_cwd: ${event.sender_cwd}`,
    `hops: ${event.hops}`,
    `conversation_id: ${event.conversation_id ?? ""}`,
    "",
    event.message,
    "",
    "This is steering/context for an existing Relay prompt. No relay_reply is required for this follow-up.",
    "Continue working on the original prompt and reply to that prompt when ready.",
  ].join("\n");
}

function formatResponseEvent(event: RelayResponseEvent, orphan: boolean): string {
  return [
    orphan ? "[Hearsay Relay orphan response]" : "[Hearsay Relay response]",
    "kind: response",
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

function normalizeChannelMeta(meta: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    // Claude Code channel meta becomes XML attributes on <channel>. Per the
    // channel contract, keys must be identifiers and values must be strings.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value == null) {
      normalized[key] = "";
    } else if (typeof value === "string") {
      normalized[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      normalized[key] = String(value);
    } else {
      normalized[key] = JSON.stringify(value);
    }
  }
  return normalized;
}

function parseCliOptions(args: string[]): CliOptions {
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }
    if (!arg?.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }

    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;

    if (["hidden", "relay-hidden"].includes(key)) {
      booleans.add(key);
      continue;
    }

    const value = inlineValue ?? args[i + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    if (inlineValue == null) i += 1;

    const existing = values.get(key) ?? [];
    existing.push(value);
    values.set(key, existing);
  }

  const cwd = getLast(values, "cwd") ?? process.env.HEARSAY_RELAY_CWD ?? process.cwd();
  const maxHopsText = getLast(values, "max-hops") ?? process.env.HEARSAY_RELAY_MAX_HOPS;
  const maxHops = maxHopsText == null ? undefined : Number(maxHopsText);
  if (maxHops != null && (!Number.isInteger(maxHops) || maxHops < 1)) {
    throw new Error(`invalid --max-hops: ${maxHopsText}`);
  }

  return {
    name: getLast(values, "name") ?? getLast(values, "relay-name") ?? process.env.HEARSAY_RELAY_NAME ?? "charlie",
    project: getLast(values, "project") ?? getLast(values, "relay-project") ?? process.env.HEARSAY_RELAY_PROJECT ?? "default",
    purpose: getLast(values, "purpose") ?? getLast(values, "relay-purpose") ?? process.env.HEARSAY_RELAY_PURPOSE ?? "Claude Code Relay peer",
    model: getLast(values, "model") ?? process.env.HEARSAY_RELAY_MODEL ?? "claude-code",
    color: getLast(values, "color") ?? getLast(values, "relay-color") ?? process.env.HEARSAY_RELAY_COLOR,
    cwd,
    relayDir: getLast(values, "dir") ?? getLast(values, "relay-dir") ?? process.env.HEARSAY_RELAY_DIR,
    hidden: booleans.has("hidden") || booleans.has("relay-hidden") || process.env.HEARSAY_RELAY_HIDDEN === "1",
    maxHops,
  };
}

function getLast(values: Map<string, string[]>, key: string): string | undefined {
  const list = values.get(key);
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

function printHelpAndExit(): never {
  console.error(`Hearsay Relay Claude Code channel MCP server\n\nUsage:\n  hearsay-relay-claude [options]\n\nOptions:\n  --name, --relay-name <name>         Relay peer name (default: charlie)\n  --project, --relay-project <name>   Relay project namespace (default: default)\n  --purpose, --relay-purpose <text>   Peer purpose (default: Claude Code Relay peer)\n  --model <name>                      Peer model label (default: claude-code)\n  --color, --relay-color <#RRGGBB>    Optional peer color\n  --dir, --relay-dir <path>           Relay storage dir (default: HEARSAY_RELAY_DIR or ~/.hearsay/relay)\n  --cwd <path>                        Peer cwd label (default: process cwd)\n  --hidden, --relay-hidden            Hide from normal relay_list_peers unless include_hidden=true\n  --max-hops <n>                      Max prompt delegation hops\n`);
  process.exit(0);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
