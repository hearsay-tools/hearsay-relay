import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  RelayRuntime,
  sendEnvelope,
  type FollowupEnvelope,
  type PromptEnvelope,
  type RelayFollowupEvent,
  type RelayPromptEvent,
  type RelayResponseEvent,
} from "../src/core/index.js";
import hearsayRelayPiExtension from "../src/pi/extension.js";

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

test("delivers followup without creating reply obligation", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  const promptSeen = oncePrompt(b);
  const followupSeen = onceFollowup(b);
  const responseSeen = onceResponse(a);

  const sent = await a.sendPrompt({
    target: "bravo",
    prompt: "start work",
    conversation_id: "conv-followup",
  });
  const prompt = await promptSeen;

  const followed = await a.followup({
    target: "bravo",
    parent_msg_id: sent.msg_id,
    message: "Please prioritize the simple implementation.",
  });

  assert.equal(followed.status, "sent");
  assert.equal(followed.target, "bravo");
  assert.notEqual(followed.msg_id, sent.msg_id);

  const followup = await followupSeen;
  assert.equal(followup.kind, "followup");
  assert.equal(followup.msg_id, followed.msg_id);
  assert.equal(followup.parent_msg_id, sent.msg_id);
  assert.equal(followup.sender_name, "alpha");
  assert.equal(followup.message, "Please prioritize the simple implementation.");
  assert.equal(followup.hops, 0);
  assert.equal(followup.conversation_id, "conv-followup");
  assert.equal(typeof followup.received_at, "string");

  assert.equal(b.getInbound(followed.msg_id), undefined);
  await assert.rejects(
    b.reply({ msg_id: followed.msg_id, response: "not a prompt" }),
    /unknown inbound msg_id/,
  );

  await b.reply({ msg_id: prompt.msg_id, response: "done" });
  const response = await responseSeen;
  assert.equal(response.response, "done");
  assert.equal(a.getOutbound(sent.msg_id)?.status, "responded");
});

test("rejects relay_followup when parent_msg_id is unknown", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  await assert.rejects(
    a.followup({ target: "bravo", parent_msg_id: "missing", message: "steer" }),
    /unknown parent_msg_id missing/,
  );
});

test("rejects relay_followup when message is empty", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  const promptSeen = oncePrompt(b);
  const sent = await a.sendPrompt({ target: "bravo", prompt: "root" });
  await promptSeen;

  await assert.rejects(
    a.followup({ target: "bravo", parent_msg_id: sent.msg_id, message: "   " }),
    /relay_followup requires a non-empty message/,
  );
});

test("rejects relay_followup when target does not match parent outbound prompt", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  const c = runtime({ relayDir, name: "charlie" });
  await Promise.all([a.start(), b.start(), c.start()]);

  const promptSeen = oncePrompt(b);
  const sent = await a.sendPrompt({ target: "bravo", prompt: "root" });
  await promptSeen;

  await assert.rejects(
    a.followup({ target: "charlie", parent_msg_id: sent.msg_id, message: "wrong target" }),
    /target charlie does not match parent_msg_id .* target bravo/,
  );
});

test("rejects relay_followup after parent outbound prompt closes", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  const promptSeen = oncePrompt(b);
  const responseSeen = onceResponse(a);
  const sent = await a.sendPrompt({ target: "bravo", prompt: "root" });
  const prompt = await promptSeen;

  await b.reply({ msg_id: prompt.msg_id, response: "closed" });
  await responseSeen;

  await assert.rejects(
    a.followup({ target: "bravo", parent_msg_id: sent.msg_id, message: "too late" }),
    /parent_msg_id .* is not open/,
  );
});

test("relay_followup preserves parent outbound hops and conversation id", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  const c = runtime({ relayDir, name: "charlie" });
  await Promise.all([a.start(), b.start(), c.start()]);

  const bravoPromptSeen = oncePrompt(b);
  await a.sendPrompt({ target: "bravo", prompt: "root" });
  const bravoPrompt = await bravoPromptSeen;

  const charliePromptSeen = oncePrompt(c);
  const sentToCharlie = await b.sendPrompt({
    target: "charlie",
    prompt: "child",
    parent_msg_id: bravoPrompt.msg_id,
    conversation_id: "conv-child",
  });
  await charliePromptSeen;

  const followupSeen = onceFollowup(c);
  await b.followup({
    target: "charlie",
    parent_msg_id: sentToCharlie.msg_id,
    message: "child steering",
  });

  const followup = await followupSeen;
  assert.equal(followup.parent_msg_id, sentToCharlie.msg_id);
  assert.equal(followup.hops, 1);
  assert.equal(followup.conversation_id, "conv-child");
});

test("NACKs duplicate followup envelopes", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  const promptSeen = oncePrompt(b);
  const sent = await a.sendPrompt({ target: "bravo", prompt: "root", conversation_id: "conv-dup" });
  await promptSeen;

  const followupSeen = onceFollowup(b);
  const envelope: FollowupEnvelope = {
    type: "followup",
    msg_id: "fixed-followup",
    sender_session: a.sessionId,
    sender_endpoint: a.endpoint,
    sender_name: a.name,
    sender_cwd: a.cwd,
    timestamp: new Date().toISOString(),
    parent_msg_id: sent.msg_id,
    message: "same followup",
    hops: sent.hops,
    conversation_id: "conv-dup",
  };

  await sendEnvelope(b.endpoint, envelope);
  const first = await followupSeen;
  assert.equal(first.msg_id, "fixed-followup");

  await assert.rejects(
    sendEnvelope(b.endpoint, envelope),
    /duplicate msg_id/,
  );
});

test("NACKs followup msg_id collisions with open inbound prompts", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  const promptSeen = oncePrompt(b);
  const sent = await a.sendPrompt({ target: "bravo", prompt: "root" });
  const prompt = await promptSeen;
  assert.equal(prompt.msg_id, sent.msg_id);

  const envelope: FollowupEnvelope = {
    type: "followup",
    msg_id: prompt.msg_id,
    sender_session: a.sessionId,
    sender_endpoint: a.endpoint,
    sender_name: a.name,
    sender_cwd: a.cwd,
    timestamp: new Date().toISOString(),
    parent_msg_id: "parent-not-relevant",
    message: "colliding followup",
    hops: 0,
    conversation_id: null,
  };

  await assert.rejects(
    sendEnvelope(b.endpoint, envelope),
    /duplicate msg_id/,
  );
  assert.equal(b.getInbound(prompt.msg_id)?.status, "open");
});

test("NACKs prompt msg_id collisions with accepted followups", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  const followupSeen = onceFollowup(b);
  const followupEnvelope: FollowupEnvelope = {
    type: "followup",
    msg_id: "followup-then-prompt-collision",
    sender_session: a.sessionId,
    sender_endpoint: a.endpoint,
    sender_name: a.name,
    sender_cwd: a.cwd,
    timestamp: new Date().toISOString(),
    parent_msg_id: "parent-not-relevant",
    message: "accepted followup",
    hops: 0,
    conversation_id: null,
  };

  await sendEnvelope(b.endpoint, followupEnvelope);
  const followup = await followupSeen;
  assert.equal(followup.msg_id, followupEnvelope.msg_id);
  assert.equal(b.getInbound(followup.msg_id), undefined);

  const promptEnvelope: PromptEnvelope = {
    type: "prompt",
    msg_id: followup.msg_id,
    sender_session: a.sessionId,
    sender_endpoint: a.endpoint,
    sender_name: a.name,
    sender_cwd: a.cwd,
    timestamp: new Date().toISOString(),
    prompt: "colliding prompt",
    hops: 0,
    parent_msg_id: null,
    conversation_id: null,
    response_schema: null,
  };

  await assert.rejects(
    sendEnvelope(b.endpoint, promptEnvelope),
    /duplicate msg_id/,
  );
  assert.equal(b.getInbound(followup.msg_id), undefined);
});

test("NACKs malformed followup envelopes", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  await assert.rejects(
    sendEnvelope(b.endpoint, {
      type: "followup",
      msg_id: "bad-followup",
      sender_session: a.sessionId,
      sender_endpoint: a.endpoint,
      timestamp: new Date().toISOString(),
      parent_msg_id: "missing-parent",
      message: "malformed because sender identity is incomplete",
      hops: 0,
    }),
    /malformed envelope/,
  );

  await assert.rejects(
    sendEnvelope(b.endpoint, {
      type: "followup",
      msg_id: "bad-followup-conversation",
      sender_session: a.sessionId,
      sender_endpoint: a.endpoint,
      sender_name: a.name,
      sender_cwd: a.cwd,
      timestamp: new Date().toISOString(),
      parent_msg_id: "missing-parent",
      message: "malformed because conversation_id is not string or null",
      hops: 0,
      conversation_id: 123,
    }),
    /malformed envelope/,
  );
});

test("accepts followup when recipient no longer has parent prompt in memory", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo" });
  await Promise.all([a.start(), b.start()]);

  const followupSeen = onceFollowup(b);
  const envelope: FollowupEnvelope = {
    type: "followup",
    msg_id: "orphan-parent-followup",
    sender_session: a.sessionId,
    sender_endpoint: a.endpoint,
    sender_name: a.name,
    sender_cwd: a.cwd,
    timestamp: new Date().toISOString(),
    parent_msg_id: "parent-not-in-memory",
    message: "still deliver this steering event",
    hops: 0,
    conversation_id: null,
  };

  await sendEnvelope(b.endpoint, envelope);
  const followup = await followupSeen;
  assert.equal(followup.msg_id, "orphan-parent-followup");
  assert.equal(followup.parent_msg_id, "parent-not-in-memory");
  assert.equal(followup.message, "still deliver this steering event");
  assert.equal(b.getInbound(followup.msg_id), undefined);
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

test("hides hidden peers from default discovery", async () => {
  const relayDir = tempRelayDir();
  const a = runtime({ relayDir, name: "alpha" });
  const b = runtime({ relayDir, name: "bravo", hidden: true });
  await Promise.all([a.start(), b.start()]);

  const visiblePeers = await a.listPeers({ ping: false });
  assert.deepEqual(visiblePeers.map((peer) => peer.name), []);

  const allPeers = await a.listPeers({ ping: false, include_hidden: true });
  assert.deepEqual(allPeers.map((peer) => peer.name), ["bravo"]);
});

test("pi peers use HEARSAY_RELAY_PROJECT as their default discovery namespace", async () => {
  const relayDir = tempRelayDir();
  const sameCwd = path.join(relayDir, "workspace");
  const peers: FakePi[] = [];
  const envKeys = ["HEARSAY_RELAY_DIR", "HEARSAY_RELAY_NAME", "HEARSAY_RELAY_PROJECT"] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

  async function startPiPeer(name: string, project: string): Promise<FakePi> {
    process.env.HEARSAY_RELAY_DIR = relayDir;
    process.env.HEARSAY_RELAY_NAME = name;
    process.env.HEARSAY_RELAY_PROJECT = project;

    const pi = new FakePi();
    hearsayRelayPiExtension(pi);
    await pi.emit("session_start", {}, { cwd: sameCwd, model: { id: "test-model" } });
    peers.push(pi);
    return pi;
  }

  try {
    const alpha = await startPiPeer("alpha", "project-x");
    await startPiPeer("bravo", "project-x");
    await startPiPeer("charlie", "project-y");
    await startPiPeer("delta", "project-y");

    const listed = await alpha.callTool("relay_list_peers", {});
    const details = listed.details as { agents: Array<{ name: string; project: string }>; project: string };
    assert.equal(details.project, "project-x");
    assert.deepEqual(details.agents.map((peer) => `${peer.name}@${peer.project}`), ["bravo@project-x"]);
  } finally {
    await Promise.allSettled(peers.map((peer) => peer.emit("session_shutdown")));
    for (const [key, value] of previousEnv) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("pi adapter exposes relay_followup and injects followups as steering messages", async () => {
  const relayDir = tempRelayDir();
  const sameCwd = path.join(relayDir, "workspace");
  const peers: FakePi[] = [];
  const envKeys = ["HEARSAY_RELAY_DIR", "HEARSAY_RELAY_NAME", "HEARSAY_RELAY_PROJECT"] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

  async function startPiPeer(name: string): Promise<FakePi> {
    process.env.HEARSAY_RELAY_DIR = relayDir;
    process.env.HEARSAY_RELAY_NAME = name;
    process.env.HEARSAY_RELAY_PROJECT = "project-followup";

    const pi = new FakePi();
    hearsayRelayPiExtension(pi);
    await pi.emit("session_start", {}, { cwd: sameCwd, model: { id: "test-model" } });
    peers.push(pi);
    return pi;
  }

  try {
    const alpha = await startPiPeer("alpha");
    const bravo = await startPiPeer("bravo");

    assert.deepEqual(alpha.toolNames(), [
      "relay_followup",
      "relay_list_peers",
      "relay_reply",
      "relay_send",
    ]);

    const sent = await alpha.callTool("relay_send", {
      target: "bravo",
      prompt: "start work",
      conversation_id: "conv-pi",
    });
    const sentDetails = sent.details as { msg_id: string };

    await alpha.callTool("relay_followup", {
      target: "bravo",
      parent_msg_id: sentDetails.msg_id,
      message: "Please steer at the next tool boundary.",
    });

    const followupMessage = bravo.messages.find((entry) => {
      return typeof entry.message.content === "string" && entry.message.content.includes("kind: followup");
    });
    assert.ok(followupMessage);
    assert.deepEqual(followupMessage.options, { deliverAs: "steer", triggerTurn: true });
    assert.match(String(followupMessage.message.content), /No relay_reply is required for this follow-up/);
    assert.match(String(followupMessage.message.content), /parent_msg_id:/);
    assert.equal((followupMessage.message.details as { kind: string }).kind, "followup");
  } finally {
    await Promise.allSettled(peers.map((peer) => peer.emit("session_shutdown")));
    for (const [key, value] of previousEnv) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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
    ["relay_followup", "relay_list_peers", "relay_reply", "relay_send"],
  );

  const listed = await client.callTool({ name: "relay_list_peers", arguments: {} });
  assert.match(toolText(listed), /kilo/);

  const responseSeen = onceResponse(kilo);
  const sentToClaude = await kilo.sendPrompt({ target: "charlie", prompt: "hello from kilo" });

  const notification = await withTimeout(notificationSeen, 2_000);
  assert.equal(notification.method, "notifications/claude/channel");
  assert.equal(notification.params.meta.kind, "prompt");
  assert.equal(notification.params.meta.msg_id, sentToClaude.msg_id);
  assert.equal(notification.params.meta.sender_name, "kilo");
  assert.match(notification.params.content, /relay_reply/);

  const followupSeen = onceClaudeChannelNotification(client);
  await kilo.followup({
    target: "charlie",
    parent_msg_id: sentToClaude.msg_id,
    message: "Please treat this as steering, not a second request.",
  });

  const followupNotification = await withTimeout(followupSeen, 2_000);
  assert.equal(followupNotification.method, "notifications/claude/channel");
  assert.equal(followupNotification.params.meta.kind, "followup");
  assert.equal(followupNotification.params.meta.parent_msg_id, sentToClaude.msg_id);
  assert.equal(followupNotification.params.meta.sender_name, "kilo");
  assert.match(followupNotification.params.content, /No relay_reply is required for this follow-up/);

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

function onceFollowup(runtime: RelayRuntime): Promise<RelayFollowupEvent> {
  return new Promise((resolve) => runtime.once("followup", resolve));
}

class FakePi {
  private readonly flags = new Map<string, unknown>();
  private readonly handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  private readonly tools = new Map<string, Record<string, any>>();
  readonly messages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];

  registerFlag(name: string, options: Record<string, unknown>): void {
    this.flags.set(name, options.default);
  }

  getFlag(name: string): unknown {
    return this.flags.get(name);
  }

  registerTool(definition: Record<string, any>): void {
    this.tools.set(String(definition.name), definition);
  }

  toolNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  registerCommand(_name: string, _definition: Record<string, unknown>): void {
    // Not needed by these tests.
  }

  on(event: string, handler: (...args: any[]) => unknown): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void {
    this.messages.push({ message, options });
  }

  appendEntry(_customType: string, _data?: unknown): void {
    // Not needed by these tests.
  }

  async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(...args);
    }
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = this.tools.get(name);
    if (!tool || typeof tool.execute !== "function") {
      throw new Error(`unknown fake pi tool: ${name}`);
    }
    return await tool.execute("fake-tool-call", params) as Record<string, unknown>;
  }
}
