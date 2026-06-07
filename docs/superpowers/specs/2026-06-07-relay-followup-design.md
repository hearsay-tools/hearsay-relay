# Relay Follow-Up Design

## Purpose

Hearsay Relay currently has only request/response semantics:

- `relay_send` opens a request that should be answered exactly once.
- `relay_reply` closes that request.

This makes steering awkward. Sending more context with `relay_send` creates a
second answer obligation, so the recipient can later reply twice: once to the
original request and once to the steering message.

Add `relay_followup` as a parented, one-way message that updates an existing
Relay request without requiring an answer.

## Public API

Add a fourth public model-facing tool:

```text
relay_followup(target, parent_msg_id, message)
```

Parameters:

- `target`: peer name or session id.
- `parent_msg_id`: required Relay prompt id from an earlier `relay_send` by
  this sender. This is the request being updated or steered.
- `message`: follow-up content, non-empty after trimming.

Semantics:

- `relay_send` starts work and creates exactly one answer obligation.
- `relay_followup` adds context or steering to that existing work and creates no
  answer obligation.
- `relay_reply` answers the original prompt.

Do not add a generic `relay_notify` tool now. If standalone one-way messages are
needed later, add a separate notify-like tool explicitly.

## Protocol

Add a new envelope type:

```ts
type: "followup"
```

The follow-up envelope carries:

- a new `msg_id` for transport-level identity and duplicate detection;
- sender identity fields matching prompt envelopes;
- `parent_msg_id`, required;
- `message`;
- `timestamp`;
- optional `conversation_id` copied from the parent outbound prompt when
  present;
- `hops` copied from the parent outbound prompt.

Follow-up envelopes receive normal ACK/NACK transport replies. ACK means the
recipient accepted the follow-up event locally. It is not semantic completion.

Do not overload `prompt`. Keeping `prompt` and `followup` separate preserves the
core invariant: prompts require replies; follow-ups do not.

## Runtime Behavior

Add `RelayRuntime.followup(args)` with args:

```ts
{
  target: string;
  parent_msg_id: string;
  message: string;
}
```

Sender validation:

- runtime must be started;
- `message` must be non-empty after trimming;
- `parent_msg_id` must be known in local outbound prompt state;
- the parent outbound prompt must still have status `sent`;
- `target` must match the parent outbound prompt's target name or target
  session;
- hop limit is not incremented because follow-up is not delegation.

The runtime should send the follow-up to the endpoint stored on the parent
outbound prompt. That keeps the follow-up tied to the original request instead
of doing a fresh target lookup that could resolve to a different peer.

Recipient behavior:

- validate envelope shape, integer non-negative `hops`, and hop limit;
- reject duplicate follow-up `msg_id`s;
- track accepted follow-up `msg_id`s in memory so duplicate envelopes are not
  delivered twice;
- emit a `followup` runtime event with the follow-up envelope fields plus
  `received_at`.

The recipient should associate the follow-up with a local inbound prompt when
`parent_msg_id` is known, but it should not hard-reject a follow-up only because
it cannot find that parent. Runtime state is currently in memory, so strict
recipient-side parent validation would break across restarts. The adapter can
still mark the injection as orphan-related if that becomes useful later.

## Adapter Behavior

Both adapters expose `relay_followup` alongside the existing tools.

Tool result text should say the follow-up was delivered and no response event
will be produced for that follow-up.

### pi

Inject follow-up events with:

```ts
pi.sendMessage(message, {
  deliverAs: "steer",
  triggerTurn: true,
});
```

Pi's `steer` scheduling delivers after the current assistant turn finishes
executing tool calls, before the next LLM call. This is the right timing for
steering an in-progress task. It is distinct from Relay's public
`relay_followup` name.

Injected text:

```text
[Hearsay Relay follow-up]
kind: followup
msg_id: <followup msg id>
parent_msg_id: <original prompt msg id>
from: <sender name> (<sender session>)
sender_cwd: <sender cwd>
hops: <hops>
conversation_id: <conversation id or empty>

<message>

This is steering/context for an existing Relay prompt. No relay_reply is
required for this follow-up. Continue working on the original prompt and reply
to that prompt when ready.
```

### Claude Code

Emit follow-up events through the existing Claude channel notification path.
Metadata should include:

- `relay: "hearsay-relay"`;
- `kind: "followup"`;
- `msg_id`;
- `parent_msg_id`;
- `sender_name`;
- `sender_session`;
- `sender_cwd`;
- `hops`;
- `conversation_id`.

The channel content should mirror the pi text and explicitly say no
`relay_reply` is required for the follow-up.

## Error Handling

Expected errors:

- unknown `parent_msg_id` on sender;
- missing or empty `message`;
- malformed follow-up envelope;
- duplicate follow-up `msg_id`;
- invalid or exceeded hops;
- `target` does not match the parent outbound prompt;
- parent outbound prompt has already responded or errored.

Do not create outbound prompt records for follow-ups, because they do not have
future responses. If tracing is useful, use a separate follow-up record or event
history rather than overloading `OutboundPromptRecord`.

## Testing

Add runtime tests for:

- follow-up delivery emits `followup` on the recipient;
- recipient does not create an inbound open prompt for the follow-up;
- recipient does not need or allow `relay_reply` for the follow-up `msg_id`;
- unknown sender-side outbound `parent_msg_id` is rejected;
- target mismatch against the parent outbound prompt is rejected;
- follow-up after the parent outbound prompt is no longer `sent` is rejected;
- duplicate follow-up envelopes are NACKed;
- follow-up preserves parent hops and conversation id;
- pi exposes `relay_followup` and injects follow-ups with
  `deliverAs: "steer"` and `triggerTurn: true`;
- Claude MCP server exposes `relay_followup` and emits channel notification
  metadata with `kind: "followup"`.

## Non-Goals

- No standalone `relay_notify`.
- No durable follow-up storage across restarts.
- No automatic response inference from assistant messages.
- No change to the rule that each `relay_send` should receive exactly one
  explicit `relay_reply`.
