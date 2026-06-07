# Architecture

This is the current-state architecture map for Hearsay Relay. The README is
for quickstart and operator examples; this file owns the durable design facts
that should survive beyond the original implementation plan. Exact TypeScript
shapes remain canonical in `src/core/types.ts`.

## Core invariants

- **Relay is asynchronous.** `relay_send` returns after the receiver ACKs the
  prompt envelope; it never waits for the final answer.
- **Replies are explicit.** Every inbound prompt is answered with
  `relay_reply(msg_id, response)` when ready. The runtime does not infer a
  response from the final assistant message and does not require Stop hooks for
  core behavior.
- **There are four public model-facing tools.** pi and Claude Code expose
  `relay_list_peers`, `relay_send`, `relay_followup`, and `relay_reply`. There
  is no public `relay_get`, `relay_await`, or `coms_*` compatibility surface in
  the current architecture.
- **Follow-ups are parented steering events.** `relay_followup(target,
  parent_msg_id, message)` requires an outbound `relay_send` `msg_id`, sends to
  that original target endpoint, and never creates a reply obligation.
- **`msg_id` is the correlation key.** Prompt envelopes mint a new `msg_id`;
  response envelopes use that original prompt `msg_id`; follow-up envelopes
  mint their own transport `msg_id` and carry the original prompt id as
  `parent_msg_id`.
- **The model supplies `parent_msg_id`, never `hops`.** When a send delegates
  work caused by an inbound prompt, the caller passes the inbound `msg_id` as
  `parent_msg_id`. The runtime derives outgoing hops from trusted local inbound
  state and rejects unknown parents or hop-limit violations.
- **Transport ACK is not semantic completion.** ACK/NACK/PONG only describe
  local receipt/liveness. The semantic answer is a later response envelope.
- **Runtime state is in memory.** The filesystem registry is discovery state,
  not durable pending-message storage.
- **Hidden peers are opt-in for discovery.** Peers started as hidden are omitted
  from normal peer lists unless `include_hidden=true`.
- **`response_schema` is currently advisory.** It is transported and causes
  inbound events to set `expects_json`, but response validation is deferred.

## Implementation map

| Area | Canonical files | Notes |
|---|---|---|
| Core runtime and state machine | `src/core/runtime.ts` | Owns start/stop, peer listing, send/reply, hop calculation, inbound/outbound records, and runtime events. |
| Protocol/types | `src/core/types.ts` | Owns envelope, registry, state-record, tool-argument, and runtime-event shapes. |
| Registry/discovery | `src/core/registry.ts` | Owns relay directory layout, registry file validation, dead-entry pruning, and name disambiguation. |
| Socket transport | `src/core/transport.ts` | Owns newline-delimited JSON over Unix sockets / Windows named pipes plus ACK/NACK/PONG replies. |
| pi adapter | `src/pi/extension.ts` | Registers pi flags/tools and injects Relay events as follow-up turns. |
| Claude Code adapter | `src/claude/channel-mcp-server.ts` | Runs an MCP server with Claude channel capability, exposes the same tools, and emits channel notifications. |
| Behavior coverage | `test/relay-runtime.test.ts` | Covers async send/reply, delegation hops, hidden discovery, Claude channel notifications, parent validation, hop limits, duplicate replies, and malformed envelopes. |

## Registry and discovery

Relay uses a local relay directory, defaulting to `~/.hearsay/relay` and
overridable with `HEARSAY_RELAY_DIR` or adapter flags.

```text
<relayDir>/
  projects/<project>/agents/<encodeURIComponent(name)>.json
  sockets/<session_id>.sock        # Unix only; Windows uses named pipes
```

Each running peer writes one registry entry with `kind:
"hearsay-relay-agent"`, `version: 2`, peer identity, process id, endpoint,
project, and `hidden`. `RelayRuntime.start()` resolves duplicate names inside a
project by appending numeric suffixes. Peer listing prunes entries whose pid is
no longer live.

`relay_list_peers` defaults to the current project. `project="*"` scans all
projects. With ping enabled, candidates receive a `ping` envelope and return an
agent card containing name, purpose, model, color, context usage, and open queue
depth.

Target resolution for `relay_send` prefers a name in the sender's current
project, then a session id across all projects, then a name across all projects.

## Transport protocol

The transport sends one JSON envelope plus `\n` to the target endpoint and reads
one JSON reply line.

| Envelope | Purpose | Important fields |
|---|---|---|
| `prompt` | Ask another peer to do work. | `msg_id`, sender identity/endpoint, `prompt`, `hops`, optional `parent_msg_id`, `conversation_id`, `response_schema`. |
| `followup` | Add steering/context to an existing request. | `msg_id`, sender identity/endpoint, required `parent_msg_id`, `message`, `hops`, optional `conversation_id`. |
| `response` | Answer a prior prompt. | original `msg_id`, sender session/endpoint, `response`, optional `error`. |
| `ping` | Liveness and peer card lookup. | `msg_id`, sender session/endpoint, timestamp. |

Immediate transport replies are:

- `ack`: envelope accepted locally;
- `nack`: envelope rejected locally with an error string;
- `pong`: ping reply with the target's agent card.

Incoming prompt validation rejects malformed envelopes, duplicate `msg_id`s,
non-integer/negative hops, and hops greater than or equal to the runtime hop
limit. The default hop limit is `5`, overridable by runtime option or
`HEARSAY_RELAY_MAX_HOPS`.

## Runtime state

Each runtime tracks two prompt indexes:

- **Inbound prompts** keyed by `msg_id`, with sender endpoint, sender name,
  prompt text, hops, optional parent/conversation/schema fields, received time,
  and status `open | replied`.
- **Outbound prompts** keyed by `msg_id`, with target identity/endpoint,
  optional parent/conversation/schema fields, hops, prompt text, sent time,
  status `sent | responded | error`, and eventual response/error data.

A `childrenByParent` index records delegated outbound prompts by inbound parent
`msg_id`. It is currently used for tracing/tests and is the seam for future
dependency-aware guards.

Unknown response envelopes produce an `orphan_response` runtime event and are
still ACKed so the sender can complete its transport call.

## Message flows

### Send prompt

```text
A relay_send(target=B, prompt=...)
A computes hops: 0 without parent_msg_id, otherwise inbound[parent].hops + 1
A records outbound[msg_id]
A sends prompt envelope to B
B validates, records inbound[msg_id], emits prompt event, ACKs
A tool call returns { msg_id, status: "sent", target, target_session, hops }
```

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

### Receive and reply

```text
B adapter injects the prompt event into the local agent session
B may do local work or delegate with relay_send(parent_msg_id=<inbound msg_id>)
B calls relay_reply(msg_id=<inbound msg_id>, response=...)
B sends response envelope to A
A updates outbound[msg_id], emits response event, ACKs
A adapter injects the response event into the local agent session
```

Responses do not advance hop count; they are tied to an existing request by
`msg_id`.

## Adapter behavior

### pi extension

The pi adapter registers flags `--relay-name`, `--relay-project`,
`--relay-purpose`, `--relay-color`, `--relay-hidden`, and `--relay-dir`. On
`session_start` it creates and starts a `RelayRuntime`; on `session_shutdown` it
stops the runtime and removes the registry entry.

Runtime prompt/response events are delivered with:

```ts
pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })
```

Injected prompt text includes `msg_id`, sender identity, hops,
`parent_msg_id`, `conversation_id`, `expects_json`, the prompt body, and an
instruction to answer with `relay_reply` or delegate with `relay_send` using the
inbound `msg_id` as `parent_msg_id`.

Runtime follow-up events are delivered with:

```ts
pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })
```

Injected follow-up text includes `msg_id`, `parent_msg_id`, sender identity,
hops, `conversation_id`, the follow-up body, and an explicit instruction that
no `relay_reply` is required for the follow-up.

### Claude Code channel MCP server

The Claude adapter is a stdio MCP server that declares:

```ts
capabilities: { experimental: { "claude/channel": {} } }
```

It exposes the same four public Relay tools and emits inbound prompt/follow-up/
response events through `notifications/claude/channel`. Channel metadata is
normalized to string attributes because Claude Code renders it on `<channel>`
messages.

The runtime is published only after MCP stdio is connected, so other peers do
not send events before the channel server can notify Claude Code.

## Security boundary

Relay is a local same-user coordination mechanism. It relies on local filesystem
permissions, process liveness checks, Unix sockets / Windows named pipes, and
optional relay-directory isolation. It does not provide network transport,
authentication, encryption, or cross-user authorization.

## Deferred/open items

- Persist pending inbound/outbound state across runtime or adapter restarts.
- Validate structured responses against `response_schema`.
- Add hidden debug/admin inspection tools if needed, without making polling a
  normal model-facing workflow.
- Add a dependency-aware guard that reminds agents about unresolved inbound
  prompts only when they are not waiting on delegated child work.
- Package the Claude Code integration as a plugin, including optional safety
  hooks, while keeping explicit `relay_reply` as the core protocol.
