# Relay Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `relay_followup(target, parent_msg_id, message)` as a parented, one-way steering message that never creates a reply obligation.

**Architecture:** Add a new `followup` envelope and runtime event beside `prompt`, `response`, and `ping`. The sender validates `parent_msg_id` against its own outbound prompt state and sends through the parent outbound endpoint, while recipients inject a follow-up event without adding an inbound prompt record. The pi adapter uses Pi `deliverAs: "steer"` for follow-up injection; Claude Code uses the existing channel notification path with `kind: "followup"`.

**Tech Stack:** TypeScript, Node `node:test`, local Unix socket / Windows named-pipe transport, pi extension API, Claude Code MCP channel notifications.

---

## File Structure

- Modify `src/core/types.ts`: add follow-up envelope, args/result/event types, and runtime event typing.
- Modify `src/core/runtime.ts`: add `RelayRuntime.followup`, follow-up envelope handling, validation, duplicate tracking, and event emission.
- Modify `src/pi/extension.ts`: expose `relay_followup`, listen for runtime follow-up events, and inject follow-ups with Pi `deliverAs: "steer"`.
- Modify `src/claude/channel-mcp-server.ts`: expose `relay_followup`, listen for follow-up events, and emit Claude channel metadata with `kind: "followup"`.
- Modify `test/relay-runtime.test.ts`: add runtime, pi adapter, and Claude adapter coverage.
- Modify `README.md` and `docs/architecture.md`: document the fourth tool and follow-up semantics.

## Task 1: Runtime Follow-Up Tests

**Files:**
- Modify: `test/relay-runtime.test.ts`

- [ ] **Step 1: Extend the test type imports**

Change the core import at the top of `test/relay-runtime.test.ts` from:

```ts
import { RelayRuntime, sendEnvelope, type RelayPromptEvent, type RelayResponseEvent } from "../src/core/index.js";
```

to:

```ts
import {
  RelayRuntime,
  sendEnvelope,
  type FollowupEnvelope,
  type RelayFollowupEvent,
  type RelayPromptEvent,
  type RelayResponseEvent,
} from "../src/core/index.js";
```

- [ ] **Step 2: Add the main follow-up delivery test**

Insert this test after `sends prompt asynchronously and delivers explicit reply`:

```ts
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
```

- [ ] **Step 3: Add parent validation and target validation tests**

Insert these tests after the main follow-up delivery test:

```ts
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
```

- [ ] **Step 4: Add hop/conversation preservation and duplicate envelope tests**

Insert these tests after the parent validation tests:

```ts
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
});
```

- [ ] **Step 5: Add a follow-up test helper**

Insert this helper after `onceResponse`:

```ts
function onceFollowup(runtime: RelayRuntime): Promise<RelayFollowupEvent> {
  return new Promise((resolve) => runtime.once("followup", resolve));
}
```

- [ ] **Step 6: Run the new runtime tests and verify they fail**

Run:

```bash
npm test
```

Expected: FAIL because `RelayRuntime.followup`, `FollowupEnvelope`, and `RelayFollowupEvent` do not exist yet.

- [ ] **Step 7: Commit the failing runtime tests**

```bash
git add test/relay-runtime.test.ts
git commit -m "test: add relay followup runtime coverage"
```

## Task 2: Core Follow-Up Protocol and Runtime

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/runtime.ts`
- Test: `test/relay-runtime.test.ts`

- [ ] **Step 1: Add follow-up protocol types**

In `src/core/types.ts`, change:

```ts
export type EnvelopeType = "prompt" | "response" | "ping";
```

to:

```ts
export type EnvelopeType = "prompt" | "response" | "ping" | "followup";
```

Insert this interface after `PromptEnvelope`:

```ts
export interface FollowupEnvelope {
  type: "followup";
  msg_id: string;
  sender_session: string;
  sender_endpoint: string;
  sender_name: string;
  sender_cwd: string;
  timestamp: string;
  parent_msg_id: string;
  message: string;
  hops: number;
  conversation_id?: string | null;
}
```

Change:

```ts
export type RelayEnvelope = PromptEnvelope | ResponseEnvelope | PingEnvelope;
```

to:

```ts
export type RelayEnvelope = PromptEnvelope | ResponseEnvelope | PingEnvelope | FollowupEnvelope;
```

Insert these interfaces after `RelaySendResult`:

```ts
export interface RelayFollowupArgs {
  target: string;
  parent_msg_id: string;
  message: string;
}

export interface RelayFollowupResult {
  msg_id: string;
  status: "sent";
  target: string;
  target_session: string;
  parent_msg_id: string;
  hops: number;
}
```

Insert this event interface after `RelayPromptEvent`:

```ts
export interface RelayFollowupEvent {
  kind: "followup";
  msg_id: string;
  sender_session: string;
  sender_endpoint: string;
  sender_name: string;
  sender_cwd: string;
  parent_msg_id: string;
  message: string;
  hops: number;
  conversation_id?: string | null;
  received_at: string;
}
```

Change `RelayRuntimeEvents` to:

```ts
export interface RelayRuntimeEvents {
  prompt: [RelayPromptEvent];
  followup: [RelayFollowupEvent];
  response: [RelayResponseEvent];
  orphan_response: [RelayResponseEvent];
}
```

- [ ] **Step 2: Import follow-up types in the runtime**

In `src/core/runtime.ts`, add these names to the existing type import block:

```ts
  FollowupEnvelope,
  RelayFollowupArgs,
  RelayFollowupEvent,
  RelayFollowupResult,
```

- [ ] **Step 3: Add duplicate tracking state**

In `RelayRuntime`, after:

```ts
  private readonly outbound = new Map<string, OutboundPromptRecord>();
```

insert:

```ts
  private readonly followups = new Set<string>();
```

- [ ] **Step 4: Implement `RelayRuntime.followup`**

Insert this method after `sendPrompt` and before `reply`:

```ts
  async followup(args: RelayFollowupArgs): Promise<RelayFollowupResult> {
    this.assertStarted();
    if (args.message.trim().length === 0) {
      throw new Error("relay_followup requires a non-empty message");
    }

    const parent = this.outbound.get(args.parent_msg_id);
    if (!parent) throw new Error(`unknown parent_msg_id ${args.parent_msg_id}`);
    if (parent.status !== "sent") {
      throw new Error(`parent_msg_id ${args.parent_msg_id} is not open`);
    }
    if (args.target !== parent.target_name && args.target !== parent.target_session) {
      throw new Error(`target ${args.target} does not match parent_msg_id ${args.parent_msg_id} target ${parent.target_name}`);
    }

    const msgId = makeId("msg");
    const sentAt = nowIso();
    const envelope: FollowupEnvelope = {
      type: "followup",
      msg_id: msgId,
      sender_session: this.sessionId,
      sender_endpoint: this.endpointPath,
      sender_name: this.runtimeName,
      sender_cwd: this.cwd,
      timestamp: sentAt,
      parent_msg_id: parent.msg_id,
      message: args.message,
      hops: parent.hops,
      conversation_id: parent.conversation_id ?? null,
    };

    await sendEnvelope(parent.target_endpoint, envelope);

    return {
      msg_id: msgId,
      status: "sent",
      target: parent.target_name,
      target_session: parent.target_session,
      parent_msg_id: parent.msg_id,
      hops: parent.hops,
    };
  }
```

- [ ] **Step 5: Route follow-up envelopes in `handleSocket`**

Replace the type dispatch in `handleSocket`:

```ts
      if (parsed.type === "prompt") {
        this.handlePrompt(socket, parsed);
      } else if (parsed.type === "response") {
        this.handleResponse(socket, parsed);
      } else {
        this.handlePing(socket, parsed);
      }
```

with:

```ts
      if (parsed.type === "prompt") {
        this.handlePrompt(socket, parsed);
      } else if (parsed.type === "followup") {
        this.handleFollowup(socket, parsed);
      } else if (parsed.type === "response") {
        this.handleResponse(socket, parsed);
      } else {
        this.handlePing(socket, parsed);
      }
```

- [ ] **Step 6: Implement follow-up envelope handling**

Insert this private method after `handlePrompt` and before `handleResponse`:

```ts
  private handleFollowup(socket: net.Socket, envelope: FollowupEnvelope): void {
    if (!Number.isInteger(envelope.hops) || envelope.hops < 0) {
      writeNack(socket, envelope.msg_id, "invalid hops");
      return;
    }
    if (envelope.hops >= this.maxHops) {
      writeNack(socket, envelope.msg_id, "hops exceeded");
      return;
    }
    if (this.followups.has(envelope.msg_id)) {
      writeNack(socket, envelope.msg_id, "duplicate msg_id");
      return;
    }

    const event: RelayFollowupEvent = {
      kind: "followup",
      msg_id: envelope.msg_id,
      sender_session: envelope.sender_session,
      sender_endpoint: envelope.sender_endpoint,
      sender_name: envelope.sender_name,
      sender_cwd: envelope.sender_cwd,
      parent_msg_id: envelope.parent_msg_id,
      message: envelope.message,
      hops: envelope.hops,
      conversation_id: envelope.conversation_id ?? null,
      received_at: nowIso(),
    };

    this.followups.add(envelope.msg_id);

    try {
      this.emit("followup", event);
    } catch (error) {
      this.followups.delete(envelope.msg_id);
      writeNack(socket, envelope.msg_id, error instanceof Error ? error.message : "followup handler failed");
      return;
    }

    writeAck(socket, envelope.msg_id);
  }
```

- [ ] **Step 7: Validate follow-up envelope shape**

In `isRelayEnvelope`, insert this branch between the `prompt` and `response` branches:

```ts
  if (envelope.type === "followup") {
    const followup = envelope as Partial<FollowupEnvelope>;
    return (
      typeof followup.sender_name === "string" &&
      typeof followup.sender_cwd === "string" &&
      typeof followup.parent_msg_id === "string" &&
      typeof followup.message === "string" &&
      typeof followup.hops === "number"
    );
  }
```

- [ ] **Step 8: Run the focused runtime tests**

Run:

```bash
npm test
```

Expected: PASS for the full test suite.

- [ ] **Step 9: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS with exit code 0.

- [ ] **Step 10: Commit runtime implementation**

```bash
git add src/core/types.ts src/core/runtime.ts test/relay-runtime.test.ts
git commit -m "feat: add relay followup runtime"
```

## Task 3: pi Adapter Follow-Up Tool and Injection

**Files:**
- Modify: `src/pi/extension.ts`
- Modify: `test/relay-runtime.test.ts`

- [ ] **Step 1: Update pi test fake to record tool names and sent messages**

In `FakePi`, add this property after the `tools` map:

```ts
  readonly messages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
```

Replace `sendMessage` in `FakePi` with:

```ts
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void {
    this.messages.push({ message, options });
  }
```

Add this method after `registerTool`:

```ts
  toolNames(): string[] {
    return [...this.tools.keys()].sort();
  }
```

- [ ] **Step 2: Add a failing pi adapter follow-up test**

Insert this test after `pi peers use HEARSAY_RELAY_PROJECT as their default discovery namespace`:

```ts
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
```

- [ ] **Step 3: Run the pi adapter test and verify it fails**

Run:

```bash
npm test
```

Expected: FAIL because `relay_followup` is not registered.

- [ ] **Step 4: Import the follow-up event type in pi adapter**

Change the type import in `src/pi/extension.ts` from:

```ts
import type { PeerInfo, RelayPromptEvent, RelayResponseEvent } from "../core/types.js";
```

to:

```ts
import type { PeerInfo, RelayFollowupEvent, RelayPromptEvent, RelayResponseEvent } from "../core/types.js";
```

- [ ] **Step 5: Add pi follow-up params schema**

Insert after `relaySendParams`:

```ts
const relayFollowupParams = Type.Object({
  target: Type.String({ description: "Peer name, or session_id. Must match the original relay_send target." }),
  parent_msg_id: Type.String({ description: "Outbound Relay msg_id from the original relay_send being steered." }),
  message: Type.String({ description: "Follow-up steering/context message. No reply is required for this follow-up." }),
});
```

- [ ] **Step 6: Register `relay_followup` in pi adapter**

Insert this tool between `relay_send` and `relay_reply`:

```ts
  pi.registerTool({
    name: "relay_followup",
    label: "Send Relay Follow-Up",
    description: "Send follow-up steering/context for an existing Relay request. Requires parent_msg_id from an earlier relay_send and does not create a reply obligation.",
    promptSnippet: "Send a Relay follow-up for an existing request; no response will arrive for the follow-up.",
    promptGuidelines: [
      "Use relay_followup to steer or add context to an existing relay_send without asking the peer to reply twice.",
      "Pass the original relay_send msg_id as parent_msg_id. The target must be the same peer as the original send.",
      "Do not call relay_reply for inbound follow-up events; reply only to the original Relay prompt when ready.",
    ],
    parameters: relayFollowupParams,
    async execute(_toolCallId: string, params: { target: string; parent_msg_id: string; message: string }) {
      const relay = requireRuntime(runtime);
      const result = await relay.followup({
        target: params.target,
        parent_msg_id: params.parent_msg_id,
        message: params.message,
      });

      return {
        content: [{
          type: "text",
          text: [
            `relay_followup → ${result.target}`,
            `msg_id: ${result.msg_id}`,
            `parent_msg_id: ${result.parent_msg_id}`,
            `status: ${result.status}`,
            `hops: ${result.hops}`,
            "No response event will be injected for this follow-up.",
          ].join("\n"),
        }],
        details: result,
      };
    },
  });
```

- [ ] **Step 7: Wire runtime follow-up events to pi injection**

In the `session_start` handler, insert this listener after the `prompt` listener:

```ts
    nextRuntime.on("followup", (event) => {
      injectFollowup(pi, currentCtx, event);
    });
```

- [ ] **Step 8: Add pi follow-up injection and formatting**

Insert this function after `injectPrompt`:

```ts
function injectFollowup(pi: PiApi, ctx: PiContext | null, event: RelayFollowupEvent): void {
  if (!ctx) throw new Error("pi context unavailable");

  pi.sendMessage({
    customType: "hearsay-relay",
    content: formatFollowupEvent(event),
    display: true,
    details: event,
  }, { deliverAs: "steer", triggerTurn: true });

  ctx.ui?.notify?.(`Relay follow-up from ${event.sender_name}: ${event.parent_msg_id}`, "info");
  pi.appendEntry?.("hearsay-relay-log", {
    event: "inbound_followup",
    msg_id: event.msg_id,
    parent_msg_id: event.parent_msg_id,
    sender_name: event.sender_name,
    sender_session: event.sender_session,
    hops: event.hops,
  });
}
```

Insert this formatter after `formatPromptEvent`:

```ts
function formatFollowupEvent(event: RelayFollowupEvent): string {
  return [
    "[Hearsay Relay follow-up]",
    `kind: followup`,
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
```

- [ ] **Step 9: Run the pi adapter test**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 10: Commit pi adapter support**

```bash
git add src/pi/extension.ts test/relay-runtime.test.ts
git commit -m "feat: expose relay followup in pi"
```

## Task 4: Claude Channel Follow-Up Tool and Notification

**Files:**
- Modify: `src/claude/channel-mcp-server.ts`
- Modify: `test/relay-runtime.test.ts`

- [ ] **Step 1: Update the Claude MCP server test expectations**

In `Claude channel MCP server exposes relay tools and emits channel notifications`, change the tool list assertion from:

```ts
    ["relay_list_peers", "relay_reply", "relay_send"],
```

to:

```ts
    ["relay_followup", "relay_list_peers", "relay_reply", "relay_send"],
```

After the prompt notification assertions:

```ts
  assert.match(notification.params.content, /relay_reply/);
```

insert:

```ts
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
```

- [ ] **Step 2: Run the Claude adapter test and verify it fails**

Run:

```bash
npm test
```

Expected: FAIL because the Claude MCP server does not expose `relay_followup`.

- [ ] **Step 3: Import the follow-up event type in Claude adapter**

Change the type import in `src/claude/channel-mcp-server.ts` from:

```ts
import type { PeerInfo, RelayPromptEvent, RelayResponseEvent } from "../core/types.js";
```

to:

```ts
import type { PeerInfo, RelayFollowupEvent, RelayPromptEvent, RelayResponseEvent } from "../core/types.js";
```

- [ ] **Step 4: Update Claude MCP server instructions**

Replace the `instructions` array with:

```ts
    instructions: [
      "Hearsay Relay is an asynchronous mailbox/event relay between agents.",
      "Use relay_list_peers to discover peers, relay_send to send async messages, relay_followup to steer existing requests, and relay_reply to explicitly answer inbound Relay prompts.",
      "relay_send returns after receiver ACK only; do not poll or wait for a response tool. Responses arrive later as Claude channel notifications.",
      "relay_followup requires parent_msg_id from an earlier relay_send and does not create a response event or reply obligation.",
      "When delegating work caused by an inbound Relay prompt, pass that inbound prompt's msg_id as relay_send parent_msg_id.",
      "Every inbound Relay prompt should be answered exactly once with relay_reply when ready.",
      "Inbound Relay follow-up events should not be answered with relay_reply; continue the original prompt and reply to that prompt when ready.",
    ].join("\n"),
```

- [ ] **Step 5: Register `relay_followup` in Claude adapter**

Insert this tool between `relay_send` and `relay_reply`:

```ts
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
```

- [ ] **Step 6: Wire runtime follow-up events to Claude notifications**

Insert this listener after `runtime.on("prompt", ...)`:

```ts
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
```

- [ ] **Step 7: Add Claude follow-up formatter**

Insert this function after `formatPromptEvent`:

```ts
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
```

- [ ] **Step 8: Run the Claude adapter test**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit Claude adapter support**

```bash
git add src/claude/channel-mcp-server.ts test/relay-runtime.test.ts
git commit -m "feat: expose relay followup in claude"
```

## Task 5: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Update README overview**

In `README.md`, replace:

```md
- pi extension adapter exposing `relay_list_peers`, `relay_send`, and `relay_reply`
- Claude Code channel MCP server exposing the same three tools
```

with:

```md
- pi extension adapter exposing `relay_list_peers`, `relay_send`, `relay_followup`, and `relay_reply`
- Claude Code channel MCP server exposing the same four tools
```

Replace:

```md
- prompt, response, and ping envelopes
```

with:

```md
- prompt, follow-up, response, and ping envelopes
```

Replace:

```md
- explicit replies via `reply(...)` / `relay_reply`
```

with:

```md
- explicit replies via `reply(...)` / `relay_reply`
- parented one-way steering via `followup(...)` / `relay_followup`
```

- [ ] **Step 2: Add README usage note**

After the paragraph:

```md
When `bravo` replies, `alpha` receives an injected Hearsay Relay response event and wakes up. No `relay_get` or `relay_await` polling is needed.
```

insert:

````md
If `alpha` needs to steer the existing request before `bravo` replies, use `relay_followup` with the original `relay_send` `msg_id`:

```text
Use relay_followup to tell bravo for parent_msg_id <alpha-to-bravo-msg-id>: "Please keep the answer short."
```

The follow-up wakes `bravo` but does not require a separate `relay_reply`. `bravo` should continue the original prompt and reply once to that original `msg_id`.
````

- [ ] **Step 3: Update architecture core invariants**

In `docs/architecture.md`, change the public tools invariant to:

```md
- **There are four public model-facing tools.** pi and Claude Code expose
  `relay_list_peers`, `relay_send`, `relay_followup`, and `relay_reply`. There
  is no public `relay_get`, `relay_await`, or `coms_*` compatibility surface in
  the current architecture.
```

Insert this invariant after the explicit replies invariant:

```md
- **Follow-ups are parented steering events.** `relay_followup(target,
  parent_msg_id, message)` requires an outbound `relay_send` `msg_id`, sends to
  that original target endpoint, and never creates a reply obligation.
```

Replace:

```md
- **`msg_id` is the correlation key.** Prompt envelopes mint a new `msg_id`;
  response envelopes use that original prompt `msg_id`.
```

with:

```md
- **`msg_id` is the correlation key.** Prompt envelopes mint a new `msg_id`;
  response envelopes use that original prompt `msg_id`; follow-up envelopes
  mint their own transport `msg_id` and carry the original prompt id as
  `parent_msg_id`.
```

- [ ] **Step 4: Update architecture protocol and flow docs**

In the transport envelope table, add this row between `prompt` and `response`:

```md
| `followup` | Add steering/context to an existing request. | `msg_id`, sender identity/endpoint, required `parent_msg_id`, `message`, `hops`, optional `conversation_id`. |
```

After the `Send prompt` flow, insert:

````md
### Send follow-up

```text
A relay_followup(target=B, parent_msg_id=<alpha msg>, message=...)
A validates parent_msg_id against local outbound prompt state
A sends followup envelope to the endpoint stored on that outbound prompt
B validates, records the follow-up msg_id for duplicate detection, emits followup event, ACKs
A tool call returns { msg_id, status: "sent", target, target_session, parent_msg_id, hops }
```

Follow-ups do not create inbound prompt records and do not produce response
events. The recipient adapter injects them as steering/context for the original
prompt.
````

- [ ] **Step 5: Update adapter behavior docs**

Keep the existing prompt/response code block, then insert:

````md
Runtime follow-up events are delivered with:

```ts
pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })
```

Injected follow-up text includes `msg_id`, `parent_msg_id`, sender identity,
hops, `conversation_id`, the follow-up body, and an explicit instruction that
no `relay_reply` is required for the follow-up.
````

In the Claude adapter section, replace:

```md
It exposes the same three public Relay tools and emits inbound prompt/response
events through `notifications/claude/channel`.
```

with:

```md
It exposes the same four public Relay tools and emits inbound prompt/follow-up/
response events through `notifications/claude/channel`.
```

- [ ] **Step 6: Run all tests**

Run:

```bash
npm test
```

Expected: PASS with all `node:test` tests passing.

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS with exit code 0.

- [ ] **Step 8: Run build**

Run:

```bash
npm run build
```

Expected: PASS with exit code 0 and emitted JavaScript under `dist/`.

- [ ] **Step 9: Commit documentation and verification cleanup**

```bash
git add README.md docs/architecture.md
git commit -m "docs: document relay followup"
```

- [ ] **Step 10: Check final status**

Run:

```bash
git status --short
```

Expected: no output.
