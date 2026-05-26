import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RelayRuntime, sendEnvelope, type RelayPromptEvent, type RelayResponseEvent } from "../src/core/index.js";

const cleanupDirs: string[] = [];
const liveRuntimes: RelayRuntime[] = [];
const liveClients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(liveClients.splice(0).map((client) => client.close()));
  await Promise.allSettled(liveRuntimes.splice(0).map((runtime) => runtime.stop()));
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sends prompt asynchronously and delivers explicit reply", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  const promptSeen = oncePrompt(b);
  const responseSeen = onceResponse(a);

  const sent = await a.sendPrompt({ target: "bravo", prompt: "hello" });
  assert.equal(sent.status, "sent");
  assert.equal(sent.hops, 0);

  const prompt = await promptSeen;
  assert.equal(prompt.kind, "prompt");
  assert.equal(prompt.msg_id, sent.msg_id);
  assert.equal(prompt.sender_name, "alpha");
  assert.equal(prompt.prompt, "hello");
  assert.equal(prompt.status, "open");

  await b.reply({ msg_id: prompt.msg_id, response: "world" });

  const response = await responseSeen;
  assert.equal(response.kind, "response");
  assert.equal(response.msg_id, sent.msg_id);
  assert.equal(response.sender_name, "bravo");
  assert.equal(response.response, "world");
  assert.equal(a.getOutbound(sent.msg_id)?.status, "responded");
  assert.equal(b.getInbound(sent.msg_id)?.status, "replied");
});

test("tracks a three-agent delegation chain", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  const c = runtime({ relayDir, name: "charlie" });
  await Promise.all([a.start(), b.start(), c.start()]);

  const bPromptSeen = oncePrompt(b);
  const aResponseSeen = onceResponse(a);

  const sentToBravo = await a.sendPrompt({ target: "bravo", prompt: "root task" });
  assert.equal(sentToBravo.hops, 0);

  const bravoPrompt = await bPromptSeen;
  assert.equal(bravoPrompt.sender_name, "alpha");
  assert.equal(bravoPrompt.hops, 0);

  const cPromptSeen = oncePrompt(c);
  const bResponseSeen = onceResponse(b);
  const sentToCharlie = await b.sendPrompt({
    target: "charlie",
    prompt: "delegated task",
    parent_msg_id: bravoPrompt.msg_id,
  });
  assert.equal(sentToCharlie.hops, 1);
  assert.deepEqual(b.getChildren(bravoPrompt.msg_id), [sentToCharlie.msg_id]);

  const charliePrompt = await cPromptSeen;
  assert.equal(charliePrompt.sender_name, "bravo");
  assert.equal(charliePrompt.hops, 1);
  assert.equal(charliePrompt.parent_msg_id, bravoPrompt.msg_id);

  await c.reply({ msg_id: charliePrompt.msg_id, response: "charlie result" });
  const childResponse = await bResponseSeen;
  assert.equal(childResponse.response, "charlie result");
  assert.equal(b.getOutbound(sentToCharlie.msg_id)?.status, "responded");

  await b.reply({
    msg_id: bravoPrompt.msg_id,
    response: { from: "bravo", child: childResponse.response },
  });

  const finalResponse = await aResponseSeen;
  assert.deepEqual(finalResponse.response, { from: "bravo", child: "charlie result" });
  assert.equal(a.getOutbound(sentToBravo.msg_id)?.status, "responded");
  assert.equal(b.getInbound(sentToBravo.msg_id)?.status, "replied");
  assert.equal(c.getInbound(sentToCharlie.msg_id)?.status, "replied");
});

test("Claude channel MCP server exposes relay tools and emits channel notifications", async () => {
  const relayDir = tempRelayDir();
  const kilo = runtime({ relayDir, name: "kilo" });
  await kilo.start();

  const client = new Client(
    { name: "test-claude-client", version: "0.0.0" },
    { capabilities: { experimental: { "claude/channel": {} } } },
  );
  liveClients.push(client);

  const notificationSeen = onceClaudeChannelNotification(client);
  const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      tsxCli,
      path.resolve("src", "claude", "channel-mcp-server.ts"),
      "--name", "charlie",
      "--project", "test",
      "--purpose", "Claude test peer",
      "--dir", relayDir,
    ],
    cwd: process.cwd(),
    stderr: "pipe",
  });

  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["relay_list", "relay_reply", "relay_send"],
  );

  const listed = await client.callTool({ name: "relay_list", arguments: {} });
  assert.match(toolText(listed), /kilo/);

  const responseSeen = onceResponse(kilo);
  const sentToClaude = await kilo.sendPrompt({ target: "charlie", prompt: "hello from kilo" });

  const notification = await withTimeout(notificationSeen, 2_000);
  assert.equal(notification.method, "notifications/claude/channel");
  assert.equal(notification.params.meta.kind, "prompt");
  assert.equal(notification.params.meta.msg_id, sentToClaude.msg_id);
  assert.equal(notification.params.meta.sender_name, "kilo");
  assert.match(notification.params.content, /relay_reply/);

  await client.callTool({
    name: "relay_reply",
    arguments: { msg_id: sentToClaude.msg_id, response: "hello back from charlie" },
  });

  const response = await withTimeout(responseSeen, 2_000);
  assert.equal(response.response, "hello back from charlie");
});

test("rejects relay_send when parent_msg_id is unknown", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  await assert.rejects(
    a.sendPrompt({ target: "bravo", prompt: "delegated", parent_msg_id: "missing" }),
    /unknown parent_msg_id missing/,
  );
});

test("computes hops from trusted parent state and rejects hop limit", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha", maxHops: 1 });
  const b = runtime({ relayDir, name: "bravo", maxHops: 1 });
  await Promise.all([a.start(), b.start()]);

  const promptSeen = oncePrompt(b);
  await a.sendPrompt({ target: "bravo", prompt: "root" });
  const prompt = await promptSeen;
  assert.equal(prompt.hops, 0);

  await assert.rejects(
    b.sendPrompt({ target: "alpha", prompt: "child", parent_msg_id: prompt.msg_id }),
    /hop limit reached \(1 >= 1\)/,
  );
});

test("rejects duplicate explicit replies", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  const promptSeen = oncePrompt(b);
  await a.sendPrompt({ target: "bravo", prompt: "answer once" });
  const prompt = await promptSeen;

  await b.reply({ msg_id: prompt.msg_id, response: "first" });
  await assert.rejects(
    b.reply({ msg_id: prompt.msg_id, response: "second" }),
    /is not open/,
  );
});

test("NACKs malformed envelopes", async () => {
  const relayDir = tempRelayDir();
  const b = runtime({ relayDir, name: "bravo" });
  await b.start();

  await assert.rejects(
    sendEnvelope(b.endpoint, { type: "prompt", msg_id: "bad" }),
    /malformed envelope/,
  );
});

function onceClaudeChannelNotification(client: Client): Promise<{ method: string; params: { content: string; meta: Record<string, any> } }> {
  return new Promise((resolve) => {
    client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === "notifications/claude/channel") {
        resolve(notification as { method: string; params: { content: string; meta: Record<string, any> } });
      }
    };
  });
}

function toolText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in result) || !Array.isArray(result.content)) return "";
  return result.content
    .filter((block): block is { type: "text"; text: string } => isTextBlock(block))
    .map((block) => block.text)
    .join("\n");
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string");
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function tempRelayDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hearsay-relay-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function runtime(options: ConstructorParameters<typeof RelayRuntime>[0]): RelayRuntime {
  const instance = new RelayRuntime({ project: "test", model: "test-model", ...options });
  liveRuntimes.push(instance);
  return instance;
}

function oncePrompt(runtime: RelayRuntime): Promise<RelayPromptEvent> {
  return new Promise((resolve) => runtime.once("prompt", resolve));
}

function onceResponse(runtime: RelayRuntime): Promise<RelayResponseEvent> {
  return new Promise((resolve) => runtime.once("response", resolve));
}
