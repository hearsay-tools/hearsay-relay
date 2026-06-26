import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { RelayRuntime, type RelayFollowupEvent, type RelayPromptEvent, type RelayResponseEvent } from "../src/core/index.js";

const cleanupDirs: string[] = [];
const liveRuntimes: RelayRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(liveRuntimes.splice(0).map((runtime) => runtime.stop()));
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logs relay runtime lifecycle events to the project journal", async () => {
  const relayDir = tempRelayDir();
  const alpha = runtime({ relayDir, name: "alpha", project: "demo", purpose: "Coordinator" });

  await alpha.start();
  await alpha.stop();

  const events = readProjectEvents(relayDir, "demo");
  assert.deepEqual(events.map((event) => event.event), ["runtime_started", "runtime_stopped"]);
  assert.equal(events[0]?.schema_version, 1);
  assert.match(String(events[0]?.event_id), /^evt_/);
  assert.equal(events[0]?.project, "demo");
  assert.deepEqual(events[0]?.observer, {
    name: "alpha",
    project: "demo",
    session_id: alpha.sessionId,
    endpoint: alpha.endpoint,
    cwd: alpha.cwd,
    model: "test-model",
  });
});

test("logs full prompt and response exchanges to the project journal", async () => {
  const relayDir = tempRelayDir();
  const alpha = runtime({ relayDir, name: "alpha", project: "demo" });
  const bravo = runtime({ relayDir, name: "bravo", project: "demo" });
  await Promise.all([alpha.start(), bravo.start()]);

  const promptSeen = oncePrompt(bravo);
  const responseSeen = onceResponse(alpha);
  const sent = await alpha.sendPrompt({ target: "bravo", prompt: "please say hello", conversation_id: "conv-1" });
  const prompt = await promptSeen;
  await bravo.reply({ msg_id: prompt.msg_id, response: { ok: true, text: "hello alpha" } });
  await responseSeen;

  const messageEvents = readProjectEvents(relayDir, "demo").filter((event) => String(event.event).includes("prompt") || String(event.event).includes("response"));
  assert.deepEqual(messageEvents.map((event) => event.event), [
    "prompt_send_attempt",
    "prompt_received",
    "prompt_send_acked",
    "response_send_attempt",
    "response_received",
    "response_send_acked",
  ]);

  assert.equal(messageEvents[0]?.msg_id, sent.msg_id);
  assert.equal(messageEvents[0]?.prompt, "please say hello");
  assert.equal(messageEvents[0]?.conversation_id, "conv-1");
  assert.deepEqual(messageEvents[0]?.from, peerSnapshot(alpha));
  assert.deepEqual(messageEvents[0]?.to, peerSnapshot(bravo));

  assert.equal(messageEvents[3]?.response && (messageEvents[3].response as { text?: string }).text, "hello alpha");
  assert.deepEqual(messageEvents[3]?.from, peerSnapshot(bravo));
  assert.equal((messageEvents[3]?.to as { name?: string } | undefined)?.name, "alpha");
  assert.equal((messageEvents[3]?.to as { session_id?: string } | undefined)?.session_id, alpha.sessionId);
});

test("logs follow-up steering messages without creating response items", async () => {
  const relayDir = tempRelayDir();
  const alpha = runtime({ relayDir, name: "alpha", project: "demo" });
  const bravo = runtime({ relayDir, name: "bravo", project: "demo" });
  await Promise.all([alpha.start(), bravo.start()]);

  const promptSeen = oncePrompt(bravo);
  const sent = await alpha.sendPrompt({ target: "bravo", prompt: "start work", conversation_id: "conv-follow" });
  await promptSeen;

  const followupSeen = onceFollowup(bravo);
  const followed = await alpha.followup({ target: "bravo", parent_msg_id: sent.msg_id, message: "keep it short" });
  await followupSeen;

  const followupEvents = readProjectEvents(relayDir, "demo").filter((event) => String(event.event).includes("followup"));
  assert.deepEqual(followupEvents.map((event) => event.event), [
    "followup_send_attempt",
    "followup_received",
    "followup_send_acked",
  ]);
  assert.equal(followupEvents[0]?.msg_id, followed.msg_id);
  assert.equal(followupEvents[0]?.parent_msg_id, sent.msg_id);
  assert.equal(followupEvents[0]?.message, "keep it short");
  assert.equal(followupEvents[0]?.conversation_id, "conv-follow");
});

function tempRelayDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hearsay-relay-log-test-"));
  cleanupDirs.push(dir);
  return dir;
}

function runtime(options: ConstructorParameters<typeof RelayRuntime>[0]): RelayRuntime {
  const instance = new RelayRuntime({ model: "test-model", ...options });
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

function peerSnapshot(runtime: RelayRuntime): Record<string, unknown> {
  return {
    name: runtime.name,
    project: runtime.project,
    session_id: runtime.sessionId,
    endpoint: runtime.endpoint,
    cwd: runtime.cwd,
    model: runtime.model,
  };
}

function readProjectEvents(relayDir: string, project: string): Array<Record<string, unknown>> {
  const file = path.join(relayDir, "projects", project, "events.jsonl");
  assert.equal(existsSync(file), true, `expected event log to exist at ${file}`);
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
