# Hearsay Relay

Async mailbox/event relay for coding agents.

This repository currently contains:

- shared Relay v2 core runtime
- pi extension adapter exposing `relay_list_peers`, `relay_send`, `relay_followup`, and `relay_reply`
- Claude Code channel MCP server exposing the same four tools

Core behavior:

- registry under `~/.hearsay/relay` by default, overridable with `HEARSAY_RELAY_DIR`
- Unix socket / Windows named-pipe transport
- prompt, follow-up, response, and ping envelopes
- explicit replies via `reply(...)` / `relay_reply`
- parented one-way steering via `followup(...)` / `relay_followup`
- runtime-computed hop counts from `parent_msg_id`
- shared append-only project event logs under `<relayDir>/projects/<project>/events.jsonl`
- no public polling/await transport API

## Architecture

See [docs/architecture.md](docs/architecture.md) for the current protocol,
runtime, adapter, and deferred-item architecture.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

## Connect two pi instances

From this repository root, open two terminals.

Terminal A:

```sh
pi -e ./src/pi/extension.ts \
  --relay-name alpha \
  --relay-project demo \
  --relay-purpose "Coordinator"
```

Terminal B:

```sh
pi -e ./src/pi/extension.ts \
  --relay-name bravo \
  --relay-project demo \
  --relay-purpose "Worker"
```

In either pi instance, ask the agent to list peers:

```text
Use relay_list_peers to show Hearsay Relay peers.
```

From `alpha`, ask it to send a message:

```text
Use relay_send to ask bravo: "Please say hello back to alpha."
```

`bravo` will receive an injected Hearsay Relay prompt and wake up. It should answer by calling `relay_reply` with the inbound `msg_id`.

When `bravo` replies, `alpha` receives an injected Hearsay Relay response event and wakes up. No `relay_get` or `relay_await` polling is needed.

If `alpha` needs to steer the existing request before `bravo` replies, use `relay_followup` with the original `relay_send` `msg_id`:

```text
Use relay_followup to tell bravo for parent_msg_id <alpha-to-bravo-msg-id>: "Please keep the answer short."
```

The follow-up wakes `bravo` but does not require a separate `relay_reply`. `bravo` should continue the original prompt and reply once to that original `msg_id`.

## Test a three-pi delegation chain

Add a third terminal:

```sh
pi -e ./src/pi/extension.ts \
  --relay-name kilo \
  --relay-project demo \
  --relay-purpose "Specialist"
```

In `alpha`, ask:

```text
Use relay_send to ask bravo: "Delegate one small subquestion to kilo using relay_send with parent_msg_id set to your inbound Relay msg_id. After kilo replies, summarize kilo's answer and call relay_reply back to alpha."
```

Expected chain:

```text
alpha --relay_send(hops=0)--> bravo
bravo --relay_send(parent_msg_id=<alpha msg>, hops=1)--> kilo
kilo --relay_reply(child msg)--> bravo
bravo --relay_reply(alpha msg)--> alpha
```

What to check:

- `bravo`'s inbound prompt shows `hops: 0`.
- `kilo`'s inbound prompt shows `hops: 1` and `parent_msg_id` equal to the alpha→bravo `msg_id`.
- `alpha` receives only the final response from `bravo`.
- No agent uses polling; all wakes are injected Relay events.

## Connect Claude Code as Charlie

Build the TypeScript first:

```sh
npm run build
```

Register the Claude Code MCP server from the project where you want to run Claude. For a project-local MCP config, set `HEARSAY_RELAY_REPO` to this repository's absolute path:

```sh
HEARSAY_RELAY_REPO=/path/to/hearsay-relay
claude mcp add -s local hearsay-relay -- \
  node "$HEARSAY_RELAY_REPO/dist/src/claude/channel-mcp-server.js" \
  --name charlie \
  --project demo \
  --purpose "Claude Code Relay peer"
```

Or run directly from source with the local `tsx` dependency:

```sh
HEARSAY_RELAY_REPO=/path/to/hearsay-relay
claude mcp add -s local hearsay-relay -- \
  node "$HEARSAY_RELAY_REPO/node_modules/tsx/dist/cli.mjs" \
  "$HEARSAY_RELAY_REPO/src/claude/channel-mcp-server.ts" \
  --name charlie \
  --project demo \
  --purpose "Claude Code Relay peer"
```

Then restart/start Claude Code in that project with the channel development bypass. The name after `server:` is the MCP config entry name (`hearsay-relay` in the `claude mcp add` commands above), not the Relay peer name (`charlie`):

```sh
claude --dangerously-load-development-channels server:hearsay-relay
```

If you used a different MCP server key, use that key instead, for example `server:my-relay`.

In Claude, run `/mcp` and verify `hearsay-relay` is connected. Then verify it sees the Relay tools and peers:

```text
Use relay_list_peers to show Hearsay Relay peers.
```

With pi peers `alpha` and `kilo` already running in project `demo`, add Claude Code as `charlie`, then try this from `alpha`:

```text
Use relay_send to ask charlie: "Ask kilo one small subquestion using relay_send with parent_msg_id set to your inbound Relay msg_id. After kilo replies, summarize kilo's answer and call relay_reply back to alpha."
```

Expected mixed chain:

```text
alpha --relay_send(hops=0)--> charlie (Claude Code)
charlie --relay_send(parent_msg_id=<alpha msg>, hops=1)--> kilo (pi)
kilo --relay_reply(child msg)--> charlie
charlie --relay_reply(alpha msg)--> alpha
```

If events do not arrive but tools work, the MCP server is loaded but not enabled as a channel. Check:

- Claude was started with `--dangerously-load-development-channels server:hearsay-relay`.
- The `server:` name matches the MCP config key from `claude mcp list`.
- Your org policy allows Claude Code channels.
- The debug log under `~/.claude/debug/<session-id>.txt` contains `[hearsay-relay] sent Claude channel notification ...` after a pi peer sends to `charlie`. If that line appears and Claude still shows no `<channel>` message, Claude is dropping the event because the channel was not enabled/allowed.

If you need to remove/re-add the MCP server:

```sh
claude mcp remove hearsay-relay
claude mcp list
```

### Useful flags

- `--relay-name <name>`: peer name
- `--relay-project <project>`: discovery namespace; peers must share this to find each other by name. Agents should talk to humans using `name@project`, but use `session_id` for cross-project `relay_send`/`relay_followup` targets.
- `--relay-purpose <text>`: short peer description
- `--relay-color <#RRGGBB>`: optional display color
- `--relay-hidden`: hide from normal `relay_list_peers` unless `include_hidden=true`
- `--relay-dir <path>`: override storage directory

You can also set `HEARSAY_RELAY_DIR` to isolate a test network:

```sh
export HEARSAY_RELAY_DIR=/tmp/hearsay-relay-demo
```

## Watch Relay traffic

Build first, then run the read-only monitor against a project event log:

```sh
npm run build
node dist/src/monitor/cli.js --project demo
# installed package binary: hearsay-relay-monitor --project demo
```

The monitor folds the shared JSONL event journal into conversation-first transcripts. It observes only the log and registry files; it does not join the relay as a peer.

## Core smoke flow

```ts
import { RelayRuntime } from "./src/core/index.js";

const a = new RelayRuntime({ name: "alpha", project: "demo" });
const b = new RelayRuntime({ name: "bravo", project: "demo" });

b.on("prompt", async (event) => {
  await b.reply({ msg_id: event.msg_id, response: "world" });
});

a.on("response", (event) => {
  console.log(event.response);
});

await Promise.all([a.start(), b.start()]);
await a.sendPrompt({ target: "bravo", prompt: "hello" });
```
