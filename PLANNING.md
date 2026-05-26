# Hearsay Relay planning context

This file summarizes the current design direction for **Hearsay Relay**: a sibling product under the Hearsay umbrella that provides a unified async communication layer between pi agents and Claude Code.

The design is based on the existing `pi-vs-cc/extensions/coms.ts`, but is not constrained by its current LLM-facing API or legacy `coms_*` naming.

## Existing legacy reference implementation

Reference file:

```text
/Users/wjarka/code/pi-vs-cc/extensions/coms.ts
```

Current protocol shape:

- local registry under `~/.pi/coms/projects/<project>/agents/<name>.json`
- Unix socket / named pipe per peer
- envelope types:
  - `prompt`
  - `response`
  - `ping`
- each prompt envelope includes `hops`
- existing pi public tools:
  - `coms_list`
  - `coms_send`
  - `coms_get`
  - `coms_await`

Current behavior in old extension:

- `coms_send` sends prompt, waits only for receiver ACK, then returns `msg_id`.
- `coms_get` polls pending reply state.
- `coms_await` blocks until reply or timeout.
- inbound prompts are answered automatically in `agent_end` by taking the last assistant message and sending it as the response.

## Key conclusion

For v2, both pi and Claude Code should work the same way:

```text
asynchronous mailbox/event loop + explicit replies
```

Not RPC-style blocking waits.

Normal model-facing API should avoid `get` / `await` polling because it teaches the LLM to block or manage transport state directly.

## Naming decision

Product/project name:

```text
Hearsay Relay
```

Public model-facing tool prefix:

```text
relay_
```

Use `relay_*` for the v2 API. Legacy `coms_*` names only describe the old reference implementation or possible compatibility aliases; they should not be the primary public affordance.

## Public LLM-facing API

Expose the same three normal Hearsay Relay tools in both pi and Claude Code:

1. `relay_list`
2. `relay_send`
3. `relay_reply`

Do not expose `relay_get` / `relay_await` in normal operation.

They may exist as hidden/debug/admin tools, but should not be part of the primary model prompt/tool affordance.

## Tool semantics

### `relay_list`

Discover peers.

Suggested args:

```ts
{
  project?: string;          // project name or "*"
  include_explicit?: boolean;
}
```

### `relay_send`

Send a prompt/message to another peer.

It is always async/non-blocking from the model's perspective:

```text
relay_send(...) -> { msg_id, status: "sent" }
```

It only waits for receiver ACK, not for the final answer.

Suggested args:

```ts
{
  target: string;              // peer name or session id
  prompt: string;              // message content
  parent_msg_id?: string;      // causal parent when delegating an inbound message
  conversation_id?: string;
  response_schema?: object;
}
```

`parent_msg_id` is important and should be part of the public API. It lets the runtime connect delegation chains:

```text
A -> B: msg a1
B -> C: relay_send(..., parent_msg_id=a1) -> msg b1
C -> B: relay_reply(b1, ...)
B -> A: relay_reply(a1, ...)
```

This supports tracing, dependency tracking, loop prevention, future guards, and hop-limit calculation.

### `relay_reply`

Explicitly reply to an inbound prompt.

Suggested args:

```ts
{
  msg_id: string;       // inbound prompt msg_id being answered
  response: unknown;    // string or JSON value
  error?: string;
}
```

This sends a `response` envelope back to the original sender.

## Auto-reply decision

We decided against auto-reply as core behavior.

Do **not** rely on:

```text
agent_end / Stop hook -> take last assistant message -> send response
```

Reasons:

- last assistant message may not be the intended protocol response
- multiple inbound prompts can overlap
- the agent may need to delegate before replying
- structured responses / JSON schemas require explicit payload control
- explicit `msg_id` correlation is safer

Therefore:

```text
inbound prompt must be answered by explicit relay_reply(msg_id, response)
```

## Claude Code hooks

A Claude Code Stop hook was only relevant for an auto-reply design.

Since v2 uses explicit `relay_reply`, a Stop hook is **not required** for the core system.

A future hook could be used as an optional safety net/guard, but not for blind auto-reply.

## Event-driven flow

### Sending

```text
A calls relay_send(target=B, prompt=...)
transport sends prompt envelope to B
B ACKs receipt
A receives { msg_id, status: "sent" }
```

A does not block waiting for B's final answer.

### Receiving a prompt

The receiver runtime injects a message/event into the local agent session and wakes the agent.

For pi:

```ts
pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })
```

For Claude Code:

```ts
mcp.notification({
  method: "notifications/claude/channel",
  params: { content, meta }
})
```

Injected event should include at least:

```text
kind="prompt"
msg_id="..."
sender_name="..."
sender_session="..."
parent_msg_id="..."?       // if present
conversation_id="..."?
expects_json="true|false"
```

### Replying

The receiver explicitly calls:

```text
relay_reply(msg_id, response)
```

This sends a `response` envelope back to the original sender.

### Receiving a response

The original sender runtime injects a response event and wakes the agent:

```text
kind="response"
msg_id="..."
sender_name="..."
response="..."
error="..."?
```

No polling required.

## Hop calculation

Important correction: the model should **not** be trusted to pass an arbitrary current hop count.

Public `relay_send` should accept `parent_msg_id`, not `hops`.

The runtime already knows the hop count of every inbound message it has accepted. Therefore:

```ts
if parent_msg_id is absent:
  outgoing_hops = 0

if parent_msg_id is present:
  parent = inboundMessages[parent_msg_id]
  if parent not found: reject
  outgoing_hops = parent.hops + 1
```

Then validate:

```ts
if outgoing_hops >= MAX_HOPS:
  reject send
```

So:

- `hops` is part of the transport envelope.
- `parent_msg_id` is part of the model-facing tool args.
- the runtime computes `hops` from trusted local state.
- the LLM never supplies `hops` directly.

This avoids bad/malicious/accidental hop values while still preserving multi-hop delegation chains.

For incoming envelopes, validate `hops` defensively:

```ts
hops must be an integer >= 0 and < MAX_HOPS
```

For responses, hop limiting is usually less important because a response is tied to an existing request. The response should correlate by `msg_id`; it does not need to advance the prompt-hop chain.

## Suggested v2 envelope shape

Prompt envelope:

```ts
interface PromptEnvelope {
  type: "prompt";
  msg_id: string;
  sender_session: string;
  sender_endpoint: string;
  sender_name: string;
  sender_cwd: string;
  timestamp: string;

  prompt: string;
  hops: number;
  parent_msg_id?: string | null;
  conversation_id?: string | null;
  response_schema?: object | null;
}
```

Response envelope:

```ts
interface ResponseEnvelope {
  type: "response";
  msg_id: string;              // original prompt msg_id being answered
  sender_session: string;
  sender_endpoint: string;
  timestamp: string;

  response: unknown;
  error?: string | null;
}
```

Ping envelope remains for liveness/status.

## State to track per runtime

Inbound prompts:

```ts
inbound[msg_id] = {
  msg_id,
  sender_session,
  sender_endpoint,
  sender_name,
  hops,
  parent_msg_id?,
  response_schema?,
  received_at,
  status: "open" | "replied"
}
```

Outbound prompts:

```ts
outbound[msg_id] = {
  msg_id,
  target_session,
  target_name,
  parent_msg_id?,
  hops,
  sent_at,
  status: "sent" | "responded" | "error"
}
```

Dependency index, useful later:

```ts
childrenByParent[parent_msg_id].add(child_msg_id)
```

This supports future dependency-aware guards without changing the public protocol.

## Optional future guard

Not required for core v2.

If added later, guard should not auto-reply. It should only remind/block when an agent is about to finish with unresolved inbound messages and no pending delegated child work.

Bad guard:

```text
Any open inbound msg -> force reply immediately
```

This breaks delegation.

Better guard condition:

```text
inbound msg is open
AND no unresolved child outbound messages exist for it
AND agent is stopping without relay_reply
```

Then inject feedback:

```text
You have an open Hearsay Relay message msg_id=XYZ. Call relay_reply, or delegate with relay_send(parent_msg_id=XYZ).
```

For Claude this could be a plugin Stop hook, but again only as a safety net, not core behavior.

For pi this could be an extension lifecycle hook.

## Claude Code integration direction

Claude Code channel MCP server is the right integration point for pushing events into Claude Code.

Channel MCP server needs:

```ts
capabilities: {
  experimental: { "claude/channel": {} },
  tools: {}
}
```

Events are pushed with:

```ts
mcp.notification({
  method: "notifications/claude/channel",
  params: { content, meta }
})
```

A plugin can later bundle:

- MCP server
- channel declaration
- optional hook(s)

But hooks are not needed for the explicit-reply core.

## Implementation plan recommendation

Build a Hearsay Relay v2 implementation rather than continuing to evolve the old polling/blocking API.

Phase 1:

1. Shared protocol/state helpers.
2. pi v2 extension:
   - `relay_list`
   - `relay_send`
   - `relay_reply`
   - inject inbound prompt events
   - inject inbound response events
   - no auto-reply
   - no public `get`/`await`
3. Claude v2 channel MCP server:
   - same three Hearsay Relay public tools
   - same registry/socket protocol
   - channel notifications for inbound prompt/response

Phase 2:

- debug/admin tools if needed
- persistence of pending state across reloads
- structured response validation
- dependency-aware guard
- packaging as Claude plugin

## Core design principle

```text
Agents communicate by asynchronous messages.
Every response is explicit and correlated by msg_id.
The LLM never blocks on transport-level await/polling.
The runtime, not the LLM, computes hop counts from parent_msg_id.
```
