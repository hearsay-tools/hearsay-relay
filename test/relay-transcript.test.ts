import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRelayEventLogEntry, type RelayEventLogInput } from "../src/core/index.js";
import { buildRelayConversations } from "../src/monitor/transcript.js";

const alpha = { name: "alpha", project: "demo", session_id: "sess-alpha" };
const bravo = { name: "bravo", project: "demo", session_id: "sess-bravo" };
const kilo = { name: "kilo", project: "demo", session_id: "sess-kilo" };

test("folds send and receive journal events into one transcript item per message", () => {
  const events = [
    entry({ event: "prompt_send_attempt", msg_id: "msg-root", from: alpha, to: bravo, prompt: "root task" }),
    entry({ event: "prompt_received", msg_id: "msg-root", from: alpha, to: bravo, prompt: "root task" }),
    entry({ event: "prompt_send_acked", msg_id: "msg-root", from: alpha, to: bravo }),
    entry({ event: "response_send_attempt", msg_id: "msg-root", from: bravo, to: alpha, response: "done" }),
    entry({ event: "response_received", msg_id: "msg-root", from: bravo, to: alpha, response: "done" }),
  ];

  const conversations = buildRelayConversations(events);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0]?.id, "msg-root");
  assert.equal(conversations[0]?.items.length, 2);
  assert.deepEqual(conversations[0]?.items.map((item) => `${item.kind}:${item.from.name}->${item.to.name}:${item.body}`), [
    "prompt:alpha->bravo:root task",
    "response:bravo->alpha:done",
  ]);
});

test("groups delegated child prompts and responses under the parent conversation", () => {
  const events = [
    entry({ event: "prompt_send_attempt", msg_id: "msg-root", from: alpha, to: bravo, prompt: "root task" }),
    entry({ event: "prompt_send_attempt", msg_id: "msg-child", parent_msg_id: "msg-root", from: bravo, to: kilo, prompt: "child task" }),
    entry({ event: "response_send_attempt", msg_id: "msg-child", from: kilo, to: bravo, response: "child done" }),
    entry({ event: "response_send_attempt", msg_id: "msg-root", from: bravo, to: alpha, response: "root done" }),
  ];

  const conversations = buildRelayConversations(events);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0]?.id, "msg-root");
  assert.deepEqual(conversations[0]?.items.map((item) => item.msg_id), ["msg-root", "msg-child", "msg-child", "msg-root"]);
});

function entry(input: Partial<RelayEventLogInput> & Pick<RelayEventLogInput, "event">) {
  return makeRelayEventLogEntry({
    project: "demo",
    observer: input.from ?? alpha,
    ...input,
  });
}
