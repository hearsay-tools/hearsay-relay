import { EventEmitter } from "node:events";
import fs from "node:fs";
import type net from "node:net";
import { appendRelayEventLog } from "./event-log.js";
import type { RelayEventLogInput, RelayEventPeerSnapshot } from "./event-log.js";
import { fallbackColor, isValidHexColor, makeId, nowIso } from "./ids.js";
import {
  defaultRelayDir,
  ensureRelayDirs,
  makeEndpoint,
  pruneDeadEntries,
  pruneDeadEntriesAcrossProjects,
  removeRegistryEntry,
  resolveUniqueName,
  writeRegistryAtomic,
} from "./registry.js";
import { bindEndpoint, readOneLine, sendEnvelope, writeAck, writeNack, writePong } from "./transport.js";
import type {
  AgentCard,
  FollowupEnvelope,
  InboundPromptRecord,
  OutboundPromptRecord,
  PeerInfo,
  PingEnvelope,
  PromptEnvelope,
  RegistryEntry,
  RelayEnvelope,
  RelayFollowupArgs,
  RelayFollowupEvent,
  RelayFollowupResult,
  RelayListOptions,
  RelayPromptEvent,
  RelayReplyArgs,
  RelayReplyResult,
  RelayResponseEvent,
  RelayRuntimeEvents,
  RelayRuntimeOptions,
  RelaySendArgs,
  RelaySendResult,
  ResponseEnvelope,
} from "./types.js";

const DEFAULT_MAX_HOPS = 5;

export class RelayRuntime extends EventEmitter<RelayRuntimeEvents> {
  readonly sessionId: string;
  readonly relayDir: string;
  readonly project: string;
  readonly purpose: string;
  readonly model: string;
  readonly cwd: string;
  readonly hidden: boolean;
  readonly maxHops: number;

  private readonly requestedName: string;
  private readonly requestedColor?: string;
  private readonly contextUsedPct?: () => number | null;
  private server: net.Server | null = null;
  private registryFile: string | null = null;
  private endpointPath: string;
  private runtimeName: string;
  private runtimeColor: string;
  private started = false;

  private readonly inbound = new Map<string, InboundPromptRecord>();
  private readonly outbound = new Map<string, OutboundPromptRecord>();
  private readonly followups = new Set<string>();
  private readonly childrenByParent = new Map<string, Set<string>>();

  constructor(options: RelayRuntimeOptions = {}) {
    super();
    this.sessionId = makeId("sess");
    this.relayDir = options.relayDir ?? defaultRelayDir();
    this.project = options.project ?? "default";
    this.purpose = options.purpose ?? "";
    this.model = options.model ?? "unknown";
    this.cwd = options.cwd ?? process.cwd();
    this.hidden = options.hidden === true;
    this.maxHops = normalizeMaxHops(options.maxHops);
    this.requestedName = options.name ?? `agent-${this.sessionId.slice(-6)}`;
    this.requestedColor = options.color;
    this.contextUsedPct = options.contextUsedPct;
    this.endpointPath = makeEndpoint(this.relayDir, this.sessionId);
    this.runtimeName = this.requestedName;
    this.runtimeColor = options.color && isValidHexColor(options.color) ? options.color : fallbackColor(this.sessionId);
  }

  get name(): string {
    return this.runtimeName;
  }

  get color(): string {
    return this.runtimeColor;
  }

  get endpoint(): string {
    return this.endpointPath;
  }

  get identity(): RegistryEntry | null {
    if (!this.started) return null;
    return this.makeRegistryEntry();
  }

  async start(): Promise<void> {
    if (this.started) return;

    ensureRelayDirs(this.relayDir, this.project);
    this.runtimeName = resolveUniqueName(this.relayDir, this.project, this.requestedName);
    this.runtimeColor = this.requestedColor && isValidHexColor(this.requestedColor)
      ? this.requestedColor
      : fallbackColor(this.sessionId);
    this.endpointPath = makeEndpoint(this.relayDir, this.sessionId);

    try {
      this.server = await bindEndpoint(this.endpointPath, (socket) => {
        void this.handleSocket(socket);
      });
      this.registryFile = writeRegistryAtomic(this.relayDir, this.makeRegistryEntry());
      this.started = true;
      this.logRelayEvent({
        project: this.project,
        observer: this.localPeerSnapshot(),
        event: "runtime_started",
      });
    } catch (error) {
      await this.closeServer();
      if (process.platform !== "win32") {
        try {
          fs.unlinkSync(this.endpointPath);
        } catch {
          // best effort
        }
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started && !this.server) return;
    if (this.started) {
      this.logRelayEvent({
        project: this.project,
        observer: this.localPeerSnapshot(),
        event: "runtime_stopped",
      });
    }
    this.started = false;
    await this.closeServer();
    removeRegistryEntry(this.relayDir, this.project, this.runtimeName);
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(this.endpointPath);
      } catch {
        // best effort
      }
    }
    this.registryFile = null;
  }

  async listPeers(options: RelayListOptions = {}): Promise<PeerInfo[]> {
    const includeHidden = options.include_hidden === true;
    const ping = options.ping !== false;
    const projectFilter = options.project ?? this.project;
    const entries = projectFilter === "*"
      ? pruneDeadEntriesAcrossProjects(this.relayDir)
      : pruneDeadEntries(this.relayDir, projectFilter);

    const candidates = entries.filter((entry) => {
      if (entry.session_id === this.sessionId) return false;
      if (entry.hidden && !includeHidden) return false;
      return true;
    });

    if (!ping) {
      return candidates.map((entry) => ({ ...entry, alive: true }));
    }

    const cards = await Promise.allSettled(candidates.map((entry) => this.pingPeer(entry)));
    return candidates.map((entry, index) => {
      const settled = cards[index];
      const agentCard = settled?.status === "fulfilled" ? settled.value : null;
      return {
        ...entry,
        alive: agentCard !== null,
        ...(agentCard ? { agent_card: agentCard } : {}),
      };
    });
  }

  async sendPrompt(args: RelaySendArgs): Promise<RelaySendResult> {
    this.assertStarted();
    if (!args.prompt) throw new Error("relay_send requires a non-empty prompt");

    const target = this.resolveTarget(args.target);
    if (!target) {
      const message = `no live relay peer matching ${JSON.stringify(args.target)}`;
      this.logRelayEvent({
        project: this.project,
        observer: this.localPeerSnapshot(),
        event: "prompt_send_failed",
        from: this.localPeerSnapshot(),
        prompt: args.prompt,
        parent_msg_id: args.parent_msg_id ?? null,
        conversation_id: args.conversation_id ?? null,
        error: message,
      });
      throw new Error(message);
    }

    const parentMsgId = args.parent_msg_id ?? null;
    const hops = this.computeOutgoingHops(parentMsgId);
    const msgId = makeId("msg");
    const sentAt = nowIso();

    const record: OutboundPromptRecord = {
      msg_id: msgId,
      target_session: target.session_id,
      target_name: target.name,
      target_project: target.project,
      target_endpoint: target.endpoint,
      parent_msg_id: parentMsgId,
      conversation_id: args.conversation_id ?? null,
      response_schema: args.response_schema ?? null,
      hops,
      prompt: args.prompt,
      sent_at: sentAt,
      status: "sent",
    };
    this.outbound.set(msgId, record);
    if (parentMsgId) this.addChild(parentMsgId, msgId);

    this.logRelayEvent({
      project: this.project,
      observer: this.localPeerSnapshot(),
      event: "prompt_send_attempt",
      msg_id: msgId,
      parent_msg_id: parentMsgId,
      conversation_id: args.conversation_id ?? null,
      hops,
      from: this.localPeerSnapshot(),
      to: registryPeerSnapshot(target),
      prompt: args.prompt,
      expects_json: args.response_schema != null,
    });

    const envelope: PromptEnvelope = {
      type: "prompt",
      msg_id: msgId,
      sender_session: this.sessionId,
      sender_endpoint: this.endpointPath,
      sender_name: this.runtimeName,
      sender_project: this.project,
      sender_cwd: this.cwd,
      timestamp: sentAt,
      prompt: args.prompt,
      hops,
      parent_msg_id: parentMsgId,
      conversation_id: args.conversation_id ?? null,
      response_schema: args.response_schema ?? null,
    };

    try {
      await sendEnvelope(target.endpoint, envelope);
    } catch (error) {
      record.status = "error";
      record.error = error instanceof Error ? error.message : String(error);
      if (parentMsgId) this.removeChild(parentMsgId, msgId);
      this.logRelayEvent({
        project: this.project,
        observer: this.localPeerSnapshot(),
        event: "prompt_send_failed",
        msg_id: msgId,
        parent_msg_id: parentMsgId,
        conversation_id: args.conversation_id ?? null,
        hops,
        from: this.localPeerSnapshot(),
        to: registryPeerSnapshot(target),
        prompt: args.prompt,
        error: record.error,
        expects_json: args.response_schema != null,
      });
      throw error;
    }

    this.logRelayEvent({
      project: this.project,
      observer: this.localPeerSnapshot(),
      event: "prompt_send_acked",
      msg_id: msgId,
      parent_msg_id: parentMsgId,
      conversation_id: args.conversation_id ?? null,
      hops,
      from: this.localPeerSnapshot(),
      to: registryPeerSnapshot(target),
      status: "acked",
    });

    return {
      msg_id: msgId,
      status: "sent",
      target: target.name,
      target_project: target.project,
      target_session: target.session_id,
      hops,
    };
  }

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
    const targetMatchesParent = args.target === parent.target_session || (
      parent.target_project === this.project && args.target === parent.target_name
    );
    if (!targetMatchesParent) {
      throw new Error(`target ${args.target} does not match parent_msg_id ${args.parent_msg_id} target ${parent.target_name}@${parent.target_project}`);
    }

    const msgId = makeId("msg");
    const sentAt = nowIso();
    const target: RelayEventPeerSnapshot = {
      name: parent.target_name,
      project: parent.target_project,
      session_id: parent.target_session,
      endpoint: parent.target_endpoint,
    };

    this.logRelayEvent({
      project: this.project,
      observer: this.localPeerSnapshot(),
      event: "followup_send_attempt",
      msg_id: msgId,
      parent_msg_id: parent.msg_id,
      conversation_id: parent.conversation_id ?? null,
      hops: parent.hops,
      from: this.localPeerSnapshot(),
      to: target,
      message: args.message,
    });

    const envelope: FollowupEnvelope = {
      type: "followup",
      msg_id: msgId,
      sender_session: this.sessionId,
      sender_endpoint: this.endpointPath,
      sender_name: this.runtimeName,
      sender_project: this.project,
      sender_cwd: this.cwd,
      timestamp: sentAt,
      parent_msg_id: parent.msg_id,
      message: args.message,
      hops: parent.hops,
      conversation_id: parent.conversation_id ?? null,
    };

    try {
      await sendEnvelope(parent.target_endpoint, envelope);
    } catch (error) {
      this.logRelayEvent({
        project: this.project,
        observer: this.localPeerSnapshot(),
        event: "followup_send_failed",
        msg_id: msgId,
        parent_msg_id: parent.msg_id,
        conversation_id: parent.conversation_id ?? null,
        hops: parent.hops,
        from: this.localPeerSnapshot(),
        to: target,
        message: args.message,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    this.logRelayEvent({
      project: this.project,
      observer: this.localPeerSnapshot(),
      event: "followup_send_acked",
      msg_id: msgId,
      parent_msg_id: parent.msg_id,
      conversation_id: parent.conversation_id ?? null,
      hops: parent.hops,
      from: this.localPeerSnapshot(),
      to: target,
      status: "acked",
    });

    return {
      msg_id: msgId,
      status: "sent",
      target: parent.target_name,
      target_project: parent.target_project,
      target_session: parent.target_session,
      parent_msg_id: parent.msg_id,
      hops: parent.hops,
    };
  }

  async reply(args: RelayReplyArgs): Promise<RelayReplyResult> {
    this.assertStarted();
    const inbound = this.inbound.get(args.msg_id);
    if (!inbound) throw new Error(`unknown inbound msg_id ${args.msg_id}`);
    if (inbound.status !== "open") throw new Error(`inbound msg_id ${args.msg_id} is not open`);

    const responseProject = inbound.sender_project ?? this.project;
    const responseTarget = inboundPeerSnapshot(inbound);
    const envelope: ResponseEnvelope = {
      type: "response",
      msg_id: inbound.msg_id,
      sender_session: this.sessionId,
      sender_endpoint: this.endpointPath,
      sender_project: this.project,
      timestamp: nowIso(),
      response: args.response,
      error: args.error ?? null,
    };

    this.logRelayEvent({
      project: responseProject,
      observer: this.localPeerSnapshot(),
      event: "response_send_attempt",
      msg_id: inbound.msg_id,
      parent_msg_id: inbound.parent_msg_id ?? null,
      conversation_id: inbound.conversation_id ?? null,
      hops: inbound.hops,
      from: this.localPeerSnapshot(),
      to: responseTarget,
      response: args.response,
      error: args.error ?? null,
    });

    try {
      await sendEnvelope(inbound.sender_endpoint, envelope);
    } catch (error) {
      this.logRelayEvent({
        project: responseProject,
        observer: this.localPeerSnapshot(),
        event: "response_send_failed",
        msg_id: inbound.msg_id,
        parent_msg_id: inbound.parent_msg_id ?? null,
        conversation_id: inbound.conversation_id ?? null,
        hops: inbound.hops,
        from: this.localPeerSnapshot(),
        to: responseTarget,
        response: args.response,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    this.logRelayEvent({
      project: responseProject,
      observer: this.localPeerSnapshot(),
      event: "response_send_acked",
      msg_id: inbound.msg_id,
      parent_msg_id: inbound.parent_msg_id ?? null,
      conversation_id: inbound.conversation_id ?? null,
      hops: inbound.hops,
      from: this.localPeerSnapshot(),
      to: responseTarget,
      status: "acked",
    });

    inbound.status = "replied";
    inbound.replied_at = nowIso();
    return { msg_id: args.msg_id, status: "sent" };
  }

  getInbound(msgId: string): InboundPromptRecord | undefined {
    return this.inbound.get(msgId);
  }

  getOutbound(msgId: string): OutboundPromptRecord | undefined {
    return this.outbound.get(msgId);
  }

  getChildren(parentMsgId: string): string[] {
    return [...(this.childrenByParent.get(parentMsgId) ?? [])];
  }

  private async handleSocket(socket: net.Socket): Promise<void> {
    let msgId = "";
    try {
      const line = await readOneLine(socket);
      const parsed = JSON.parse(line) as unknown;
      msgId = extractMsgId(parsed);

      if (!isRelayEnvelope(parsed)) {
        writeNack(socket, msgId, "malformed envelope");
        return;
      }

      if (parsed.type === "prompt") {
        this.handlePrompt(socket, parsed);
      } else if (parsed.type === "followup") {
        this.handleFollowup(socket, parsed);
      } else if (parsed.type === "response") {
        this.handleResponse(socket, parsed);
      } else {
        this.handlePing(socket, parsed);
      }
    } catch (error) {
      writeNack(socket, msgId, error instanceof SyntaxError ? "malformed envelope" : "internal error");
    }
  }

  private handlePrompt(socket: net.Socket, envelope: PromptEnvelope): void {
    if (!Number.isInteger(envelope.hops) || envelope.hops < 0) {
      writeNack(socket, envelope.msg_id, "invalid hops");
      return;
    }
    if (envelope.hops >= this.maxHops) {
      writeNack(socket, envelope.msg_id, "hops exceeded");
      return;
    }
    if (this.hasKnownMessageId(envelope.msg_id)) {
      writeNack(socket, envelope.msg_id, "duplicate msg_id");
      return;
    }

    const record: InboundPromptRecord = {
      msg_id: envelope.msg_id,
      sender_session: envelope.sender_session,
      sender_endpoint: envelope.sender_endpoint,
      sender_name: envelope.sender_name,
      sender_project: envelope.sender_project ?? null,
      sender_cwd: envelope.sender_cwd,
      prompt: envelope.prompt,
      hops: envelope.hops,
      parent_msg_id: envelope.parent_msg_id ?? null,
      conversation_id: envelope.conversation_id ?? null,
      response_schema: envelope.response_schema ?? null,
      received_at: nowIso(),
      status: "open",
    };
    this.inbound.set(envelope.msg_id, record);

    const event: RelayPromptEvent = {
      ...record,
      kind: "prompt",
      expects_json: envelope.response_schema != null,
    };

    try {
      this.emit("prompt", event);
    } catch (error) {
      this.inbound.delete(envelope.msg_id);
      writeNack(socket, envelope.msg_id, error instanceof Error ? error.message : "prompt handler failed");
      return;
    }

    this.logRelayEvent({
      project: envelope.sender_project ?? this.project,
      observer: this.localPeerSnapshot(),
      event: "prompt_received",
      msg_id: envelope.msg_id,
      parent_msg_id: envelope.parent_msg_id ?? null,
      conversation_id: envelope.conversation_id ?? null,
      hops: envelope.hops,
      from: envelopeSenderSnapshot(envelope),
      to: this.localPeerSnapshot(),
      prompt: envelope.prompt,
      expects_json: envelope.response_schema != null,
    });

    writeAck(socket, envelope.msg_id);
  }

  private handleFollowup(socket: net.Socket, envelope: FollowupEnvelope): void {
    if (!Number.isInteger(envelope.hops) || envelope.hops < 0) {
      writeNack(socket, envelope.msg_id, "invalid hops");
      return;
    }
    if (envelope.hops >= this.maxHops) {
      writeNack(socket, envelope.msg_id, "hops exceeded");
      return;
    }
    if (this.hasKnownMessageId(envelope.msg_id)) {
      writeNack(socket, envelope.msg_id, "duplicate msg_id");
      return;
    }

    const event: RelayFollowupEvent = {
      kind: "followup",
      msg_id: envelope.msg_id,
      sender_session: envelope.sender_session,
      sender_endpoint: envelope.sender_endpoint,
      sender_name: envelope.sender_name,
      sender_project: envelope.sender_project ?? null,
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

    this.logRelayEvent({
      project: envelope.sender_project ?? this.project,
      observer: this.localPeerSnapshot(),
      event: "followup_received",
      msg_id: envelope.msg_id,
      parent_msg_id: envelope.parent_msg_id,
      conversation_id: envelope.conversation_id ?? null,
      hops: envelope.hops,
      from: envelopeSenderSnapshot(envelope),
      to: this.localPeerSnapshot(),
      message: envelope.message,
    });

    writeAck(socket, envelope.msg_id);
  }

  private handleResponse(socket: net.Socket, envelope: ResponseEnvelope): void {
    const outbound = this.outbound.get(envelope.msg_id);
    const event: RelayResponseEvent = {
      kind: "response",
      msg_id: envelope.msg_id,
      sender_session: envelope.sender_session,
      sender_name: outbound?.target_name ?? envelope.sender_session,
      sender_project: outbound?.target_project ?? envelope.sender_project ?? null,
      response: envelope.response,
      error: envelope.error ?? null,
      received_at: nowIso(),
    };

    if (!outbound) {
      try {
        this.emit("orphan_response", event);
      } catch {
        // The response is already orphaned; still ACK so the remote can finish.
      }
      this.logRelayEvent({
        project: this.project,
        observer: this.localPeerSnapshot(),
        event: "orphan_response_received",
        msg_id: envelope.msg_id,
        from: responseSenderSnapshot(envelope, event),
        to: this.localPeerSnapshot(),
        response: envelope.response,
        error: envelope.error ?? null,
        orphan: true,
      });
      writeAck(socket, envelope.msg_id);
      return;
    }

    outbound.status = envelope.error ? "error" : "responded";
    outbound.response = envelope.response;
    outbound.error = envelope.error ?? null;
    outbound.responded_at = event.received_at;

    try {
      this.emit("response", event);
    } catch (error) {
      writeNack(socket, envelope.msg_id, error instanceof Error ? error.message : "response handler failed");
      return;
    }

    this.logRelayEvent({
      project: this.project,
      observer: this.localPeerSnapshot(),
      event: "response_received",
      msg_id: envelope.msg_id,
      parent_msg_id: outbound.parent_msg_id ?? null,
      conversation_id: outbound.conversation_id ?? null,
      hops: outbound.hops,
      from: responseSenderSnapshot(envelope, event),
      to: this.localPeerSnapshot(),
      response: envelope.response,
      error: envelope.error ?? null,
      orphan: false,
    });

    writeAck(socket, envelope.msg_id);
  }

  private handlePing(socket: net.Socket, envelope: PingEnvelope): void {
    writePong(socket, {
      type: "pong",
      msg_id: envelope.msg_id,
      agent_card: this.agentCard(),
    });
  }

  private async pingPeer(entry: RegistryEntry): Promise<AgentCard | null> {
    if (!this.started) return null;
    const envelope: PingEnvelope = {
      type: "ping",
      msg_id: makeId("ping"),
      sender_session: this.sessionId,
      sender_endpoint: this.endpointPath,
      timestamp: nowIso(),
    };

    try {
      const reply = await sendEnvelope(entry.endpoint, envelope);
      return reply.type === "pong" ? reply.agent_card : null;
    } catch {
      return null;
    }
  }

  private resolveTarget(target: string): RegistryEntry | null {
    const localEntries = pruneDeadEntries(this.relayDir, this.project);
    const localByName = localEntries.find((entry) => entry.name === target);
    if (localByName) return localByName;

    const allEntries = pruneDeadEntriesAcrossProjects(this.relayDir);
    return allEntries.find((entry) => entry.session_id === target) ?? null;
  }

  private computeOutgoingHops(parentMsgId: string | null): number {
    if (!parentMsgId) return 0;
    const parent = this.inbound.get(parentMsgId);
    if (!parent) throw new Error(`unknown parent_msg_id ${parentMsgId}`);

    const hops = parent.hops + 1;
    if (hops >= this.maxHops) {
      throw new Error(`hop limit reached (${hops} >= ${this.maxHops})`);
    }
    return hops;
  }

  private makeRegistryEntry(): RegistryEntry {
    return {
      kind: "hearsay-relay-agent",
      version: 2,
      session_id: this.sessionId,
      name: this.runtimeName,
      purpose: this.purpose,
      model: this.model,
      color: this.runtimeColor,
      pid: process.pid,
      endpoint: this.endpointPath,
      cwd: this.cwd,
      started_at: nowIso(),
      hidden: this.hidden,
      project: this.project,
      heartbeat_at: nowIso(),
    };
  }

  private agentCard(): AgentCard {
    return {
      name: this.runtimeName,
      purpose: this.purpose,
      model: this.model,
      color: this.runtimeColor,
      context_used_pct: clampContextPct(this.contextUsedPct?.() ?? null),
      queue_depth: [...this.inbound.values()].filter((record) => record.status === "open").length,
    };
  }

  private addChild(parentMsgId: string, childMsgId: string): void {
    const children = this.childrenByParent.get(parentMsgId) ?? new Set<string>();
    children.add(childMsgId);
    this.childrenByParent.set(parentMsgId, children);
  }

  private removeChild(parentMsgId: string, childMsgId: string): void {
    const children = this.childrenByParent.get(parentMsgId);
    if (!children) return;
    children.delete(childMsgId);
    if (children.size === 0) this.childrenByParent.delete(parentMsgId);
  }

  private hasKnownMessageId(msgId: string): boolean {
    return this.inbound.has(msgId) || this.outbound.has(msgId) || this.followups.has(msgId);
  }

  private assertStarted(): void {
    if (!this.started) throw new Error("relay runtime is not started");
  }

  private localPeerSnapshot(): RelayEventPeerSnapshot {
    return {
      name: this.runtimeName,
      project: this.project,
      session_id: this.sessionId,
      endpoint: this.endpointPath,
      cwd: this.cwd,
      model: this.model,
    };
  }

  private logRelayEvent(event: RelayEventLogInput): void {
    try {
      appendRelayEventLog(this.relayDir, event);
    } catch {
      // Relay event logging is best-effort and must not affect delivery.
    }
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;

    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

function registryPeerSnapshot(entry: RegistryEntry): RelayEventPeerSnapshot {
  return {
    name: entry.name,
    project: entry.project,
    session_id: entry.session_id,
    endpoint: entry.endpoint,
    cwd: entry.cwd,
    model: entry.model,
  };
}

function inboundPeerSnapshot(record: InboundPromptRecord): RelayEventPeerSnapshot {
  return {
    name: record.sender_name,
    project: record.sender_project ?? null,
    session_id: record.sender_session,
    endpoint: record.sender_endpoint,
    cwd: record.sender_cwd,
  };
}

function envelopeSenderSnapshot(envelope: PromptEnvelope | FollowupEnvelope): RelayEventPeerSnapshot {
  return {
    name: envelope.sender_name,
    project: envelope.sender_project ?? null,
    session_id: envelope.sender_session,
    endpoint: envelope.sender_endpoint,
    cwd: envelope.sender_cwd,
  };
}

function responseSenderSnapshot(envelope: ResponseEnvelope, event: RelayResponseEvent): RelayEventPeerSnapshot {
  return {
    name: event.sender_name,
    project: event.sender_project ?? envelope.sender_project ?? null,
    session_id: envelope.sender_session,
    endpoint: envelope.sender_endpoint,
  };
}

function normalizeMaxHops(value: number | undefined): number {
  const envValue = Number(process.env.HEARSAY_RELAY_MAX_HOPS);
  const candidate = value ?? (Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_MAX_HOPS);
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw new Error(`invalid maxHops: ${candidate}`);
  }
  return candidate;
}

function clampContextPct(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function extractMsgId(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const maybe = (value as { msg_id?: unknown }).msg_id;
  return typeof maybe === "string" ? maybe : "";
}

function isRelayEnvelope(value: unknown): value is RelayEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<RelayEnvelope>;
  if (typeof envelope.type !== "string") return false;
  if (typeof envelope.msg_id !== "string") return false;
  if (typeof envelope.sender_session !== "string") return false;
  if (typeof envelope.sender_endpoint !== "string") return false;
  if (typeof envelope.timestamp !== "string") return false;

  if (envelope.type === "prompt") {
    const prompt = envelope as Partial<PromptEnvelope>;
    return (
      typeof prompt.sender_name === "string" &&
      isOptionalString(prompt.sender_project) &&
      typeof prompt.sender_cwd === "string" &&
      typeof prompt.prompt === "string" &&
      typeof prompt.hops === "number"
    );
  }

  if (envelope.type === "followup") {
    const followup = envelope as Partial<FollowupEnvelope>;
    return (
      typeof followup.sender_name === "string" &&
      isOptionalString(followup.sender_project) &&
      typeof followup.sender_cwd === "string" &&
      typeof followup.parent_msg_id === "string" &&
      typeof followup.message === "string" &&
      typeof followup.hops === "number" &&
      (followup.conversation_id == null || typeof followup.conversation_id === "string")
    );
  }

  if (envelope.type === "response") {
    const response = envelope as Partial<ResponseEnvelope>;
    return "response" in response && isOptionalString(response.sender_project);
  }

  return envelope.type === "ping";
}

function isOptionalString(value: unknown): boolean {
  return value == null || typeof value === "string";
}
