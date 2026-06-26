#!/usr/bin/env node
import readline from "node:readline";
import { defaultRelayDir, readRelayEventLog, relayEventLogPath } from "../core/index.js";
import { buildRelayConversations, peerLabel, type RelayConversation } from "./transcript.js";

interface MonitorOptions {
  relayDir: string;
  project: string;
}

type FocusPane = "conversations" | "transcript";

const options = parseArgs(process.argv.slice(2));
let conversations: RelayConversation[] = [];
let selectedConversation = 0;
let transcriptScroll = 0;
let focus: FocusPane = "conversations";
let closed = false;

loadEvents();

if (!process.stdout.isTTY || !process.stdin.isTTY) {
  printSnapshot();
  process.exit(0);
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdout.write("\x1b[?1049h\x1b[?25l");
render();

const poll = setInterval(() => {
  const previousCount = conversations.reduce((sum, conversation) => sum + conversation.events.length, 0);
  loadEvents();
  const nextCount = conversations.reduce((sum, conversation) => sum + conversation.events.length, 0);
  if (nextCount !== previousCount) render();
}, 750);
poll.unref();

process.stdin.on("keypress", (_str, key) => {
  if (!key) return;
  if (key.ctrl && key.name === "c") return quit(130);
  if (key.name === "q") return quit(0);
  if (key.name === "tab") {
    focus = focus === "conversations" ? "transcript" : "conversations";
    render();
    return;
  }
  if (key.name === "r") {
    loadEvents();
    render();
    return;
  }

  if (key.name === "up" || key.name === "k") {
    move(-1);
    render();
    return;
  }
  if (key.name === "down" || key.name === "j") {
    move(1);
    render();
  }
});

process.stdout.on("resize", render);
process.once("SIGINT", () => quit(130));
process.once("SIGTERM", () => quit(143));

function loadEvents(): void {
  conversations = buildRelayConversations(readRelayEventLog(options.relayDir, options.project));
  if (selectedConversation >= conversations.length) selectedConversation = Math.max(0, conversations.length - 1);
  transcriptScroll = Math.max(0, transcriptScroll);
}

function move(delta: number): void {
  if (focus === "conversations") {
    selectedConversation = clamp(selectedConversation + delta, 0, Math.max(0, conversations.length - 1));
    transcriptScroll = 0;
    return;
  }
  const maxScroll = Math.max(0, transcriptLines(conversations[selectedConversation]).length - transcriptHeight());
  transcriptScroll = clamp(transcriptScroll + delta, 0, maxScroll);
}

function render(): void {
  if (closed) return;
  const width = process.stdout.columns || 100;
  const height = process.stdout.rows || 30;
  const leftWidth = clamp(Math.floor(width * 0.34), 26, Math.min(46, width - 30));
  const rightWidth = Math.max(20, width - leftWidth - 1);
  const bodyHeight = Math.max(1, height - 3);
  const selected = conversations[selectedConversation];
  const rightLines = transcriptLines(selected);

  const rows: string[] = [];
  rows.push(truncate(`Hearsay Relay monitor · project=${options.project} · ${conversations.length} conversation(s) · ${relayEventLogPath(options.relayDir, options.project)}`, width));
  rows.push(`${padRight(focus === "conversations" ? "▶ Conversations" : "  Conversations", leftWidth)}│${padRight(focus === "transcript" ? "▶ Transcript" : "  Transcript", rightWidth)}`);

  for (let i = 0; i < bodyHeight; i += 1) {
    const conversation = conversations[i];
    const left = renderConversationLine(conversation, i, leftWidth);
    const right = truncate(rightLines[i + transcriptScroll] ?? "", rightWidth);
    rows.push(`${left}│${padRight(right, rightWidth)}`);
  }

  rows.push(truncate("↑/↓ j/k navigate · tab switch pane · r reload · q quit", width));

  process.stdout.write("\x1b[H\x1b[2J" + rows.slice(0, height).map((line) => truncate(line, width)).join("\n"));
}

function renderConversationLine(conversation: RelayConversation | undefined, index: number, width: number): string {
  if (!conversation) return " ".repeat(width);
  const marker = index === selectedConversation ? "› " : "  ";
  const count = conversation.items.length;
  const text = `${marker}${conversation.title} (${count})`;
  return padRight(truncate(text, width), width);
}

function transcriptLines(conversation: RelayConversation | undefined): string[] {
  if (!conversation) return ["No relay conversations yet.", "", "Start pi/Claude peers and send a relay message."];
  const lines: string[] = [];
  lines.push(conversation.title);
  lines.push(`conversation_id: ${conversation.id}`);
  lines.push("");
  for (const item of conversation.items) {
    const header = `${iconFor(item.kind)} ${peerLabel(item.from)} → ${peerLabel(item.to)} · ${item.kind} · ${item.msg_id}${item.parent_msg_id ? ` · parent ${item.parent_msg_id}` : ""}`;
    lines.push(header);
    for (const bodyLine of wrap(item.body, Math.max(20, (process.stdout.columns || 100) - 50))) {
      lines.push(`  ${bodyLine}`);
    }
    if (item.error) lines.push(`  error: ${item.error}`);
    lines.push("");
  }
  return lines;
}

function transcriptHeight(): number {
  return Math.max(1, (process.stdout.rows || 30) - 3);
}

function printSnapshot(): void {
  if (conversations.length === 0) {
    console.log(`No Relay conversations found for project ${options.project}.`);
    return;
  }
  for (const conversation of conversations) {
    console.log(`# ${conversation.title}`);
    for (const item of conversation.items) {
      console.log(`${item.kind}: ${peerLabel(item.from)} -> ${peerLabel(item.to)} (${item.msg_id})`);
      console.log(indent(item.body));
    }
    console.log("");
  }
}

function quit(code: number): void {
  if (closed) return;
  closed = true;
  clearInterval(poll);
  try {
    process.stdin.setRawMode(false);
  } catch {
    // ignore
  }
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  process.exit(code);
}

function parseArgs(args: string[]): MonitorOptions {
  let relayDir = process.env.HEARSAY_RELAY_DIR || defaultRelayDir();
  let project = process.env.HEARSAY_RELAY_PROJECT || "default";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--project" || arg === "-p") {
      project = requireValue(args, ++i, arg);
      continue;
    }
    if (arg === "--dir" || arg === "--relay-dir") {
      relayDir = requireValue(args, ++i, arg);
      continue;
    }
    if (arg?.startsWith("--project=")) {
      project = arg.slice("--project=".length);
      continue;
    }
    if (arg?.startsWith("--dir=")) {
      relayDir = arg.slice("--dir=".length);
      continue;
    }
    if (arg?.startsWith("--relay-dir=")) {
      relayDir = arg.slice("--relay-dir=".length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { relayDir, project };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log([
    "usage: hearsay-relay-monitor [--project <project>] [--relay-dir <dir>]",
    "",
    "Read-only terminal monitor for Hearsay Relay event logs.",
    "Defaults: --project $HEARSAY_RELAY_PROJECT or default; --relay-dir $HEARSAY_RELAY_DIR or ~/.hearsay/relay.",
  ].join("\n"));
}

function iconFor(kind: string): string {
  if (kind === "prompt") return "📨";
  if (kind === "followup") return "↪";
  return "📬";
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const inputLine of text.split("\n")) {
    let rest = inputLine;
    if (!rest) {
      lines.push("");
      continue;
    }
    while (rest.length > width) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    lines.push(rest);
  }
  return lines;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function padRight(value: string, width: number): string {
  const truncated = truncate(value, width);
  return truncated + " ".repeat(Math.max(0, width - visibleLength(truncated)));
}

function truncate(value: string, width: number): string {
  if (visibleLength(value) <= width) return value;
  if (width <= 1) return value.slice(0, Math.max(0, width));
  return value.slice(0, Math.max(0, width - 1)) + "…";
}

function visibleLength(value: string): number {
  return [...value].length;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}
