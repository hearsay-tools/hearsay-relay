import type { RelayEventLogEntry, RelayEventName, RelayEventPeerSnapshot } from "../core/event-log.js";

export type RelayTranscriptKind = "prompt" | "followup" | "response";

export interface RelayTranscriptItem {
  kind: RelayTranscriptKind;
  msg_id: string;
  parent_msg_id?: string | null;
  conversation_id: string;
  from: RelayEventPeerSnapshot;
  to: RelayEventPeerSnapshot;
  body: string;
  observed_at: string;
  event: RelayEventName;
  events: RelayEventLogEntry[];
  error?: string | null;
}

export interface RelayConversation {
  id: string;
  title: string;
  last_observed_at: string;
  items: RelayTranscriptItem[];
  events: RelayEventLogEntry[];
}

interface OrderedEvent {
  event: RelayEventLogEntry;
  index: number;
}

interface PendingItem {
  item: RelayTranscriptItem;
  order: number;
}

export function buildRelayConversations(events: RelayEventLogEntry[]): RelayConversation[] {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort(compareOrderedEvents);

  const conversationByMsgId = new Map<string, string>();
  for (const { event } of ordered) {
    if (!event.msg_id) continue;
    const kind = transcriptKind(event.event);
    if (kind !== "prompt") continue;
    const conversationId = conversationIdFor(event, conversationByMsgId);
    if (conversationId) conversationByMsgId.set(event.msg_id, conversationId);
  }

  const byConversation = new Map<string, { events: RelayEventLogEntry[]; items: Map<string, PendingItem> }>();

  for (const { event, index } of ordered) {
    const conversationId = conversationIdFor(event, conversationByMsgId);
    if (!conversationId) continue;
    const conversation = byConversation.get(conversationId) ?? { events: [], items: new Map<string, PendingItem>() };
    conversation.events.push(event);
    byConversation.set(conversationId, conversation);

    const item = transcriptItemFor(event, conversationId);
    if (!item) continue;

    const key = `${item.kind}:${item.msg_id}`;
    const current = conversation.items.get(key);
    if (!current) {
      conversation.items.set(key, { item, order: index });
      continue;
    }

    current.item.events.push(event);
    if (prefersEvent(event.event, current.item.event)) {
      conversation.items.set(key, {
        item: { ...item, events: current.item.events },
        order: current.order,
      });
    }
  }

  return [...byConversation.entries()]
    .map(([id, conversation]) => {
      const items = [...conversation.items.values()]
        .sort((a, b) => a.order - b.order)
        .map((pending) => pending.item);
      const last = conversation.events[conversation.events.length - 1];
      return {
        id,
        title: titleForConversation(id, items),
        last_observed_at: last?.observed_at ?? "",
        items,
        events: conversation.events,
      } satisfies RelayConversation;
    })
    .sort((a, b) => b.last_observed_at.localeCompare(a.last_observed_at));
}

function transcriptItemFor(event: RelayEventLogEntry, conversationId: string): RelayTranscriptItem | null {
  const kind = transcriptKind(event.event);
  if (!kind || !event.msg_id) return null;

  const body = bodyFor(kind, event);
  if (body == null) return null;

  return {
    kind,
    msg_id: event.msg_id,
    parent_msg_id: event.parent_msg_id ?? null,
    conversation_id: conversationId,
    from: event.from ?? event.observer,
    to: event.to ?? unknownPeer(),
    body,
    observed_at: event.observed_at,
    event: event.event,
    events: [event],
    error: event.error ?? null,
  };
}

function conversationIdFor(event: RelayEventLogEntry, conversationByMsgId: Map<string, string>): string | null {
  if (event.conversation_id) return event.conversation_id;
  const kind = transcriptKind(event.event);
  if (kind === "prompt") return event.parent_msg_id ?? event.msg_id ?? null;
  if (kind === "followup") return event.parent_msg_id ?? event.msg_id ?? null;
  if (kind === "response" && event.msg_id) return conversationByMsgId.get(event.msg_id) ?? event.msg_id;
  return event.msg_id ?? null;
}

function transcriptKind(event: RelayEventName): RelayTranscriptKind | null {
  switch (event) {
    case "prompt_send_attempt":
    case "prompt_received":
      return "prompt";
    case "followup_send_attempt":
    case "followup_received":
      return "followup";
    case "response_send_attempt":
    case "response_received":
    case "orphan_response_received":
      return "response";
    default:
      return null;
  }
}

function bodyFor(kind: RelayTranscriptKind, event: RelayEventLogEntry): string | null {
  if (kind === "prompt") return event.prompt ?? null;
  if (kind === "followup") return event.message ?? null;
  if (kind === "response") return formatUnknown(event.response);
  return null;
}

function formatUnknown(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function prefersEvent(candidate: RelayEventName, current: RelayEventName): boolean {
  return candidate.endsWith("_send_attempt") && current.endsWith("_received");
}

function titleForConversation(id: string, items: RelayTranscriptItem[]): string {
  const first = items[0];
  if (!first) return id;
  return `${peerLabel(first.from)} → ${peerLabel(first.to)} · ${truncateOneLine(first.body, 48)}`;
}

export function peerLabel(peer: RelayEventPeerSnapshot): string {
  return peer.project ? `${peer.name}@${peer.project}` : peer.name;
}

function truncateOneLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

function unknownPeer(): RelayEventPeerSnapshot {
  return { name: "unknown", session_id: "unknown" };
}

function compareOrderedEvents(a: OrderedEvent, b: OrderedEvent): number {
  const time = a.event.observed_at.localeCompare(b.event.observed_at);
  return time === 0 ? a.index - b.index : time;
}
