export type EnvelopeType = "prompt" | "response" | "ping";

export interface PromptEnvelope {
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
  response_schema?: unknown | null;
}

export interface ResponseEnvelope {
  type: "response";
  msg_id: string;
  sender_session: string;
  sender_endpoint: string;
  timestamp: string;
  response: unknown;
  error?: string | null;
}

export interface PingEnvelope {
  type: "ping";
  msg_id: string;
  sender_session: string;
  sender_endpoint: string;
  timestamp: string;
}

export type RelayEnvelope = PromptEnvelope | ResponseEnvelope | PingEnvelope;

export interface AckEnvelope {
  type: "ack";
  msg_id: string;
}

export interface NackEnvelope {
  type: "nack";
  msg_id: string;
  error: string;
}

export interface PongEnvelope {
  type: "pong";
  msg_id: string;
  agent_card: AgentCard;
}

export type RelayReplyEnvelope = AckEnvelope | NackEnvelope | PongEnvelope;

export interface AgentCard {
  name: string;
  purpose: string;
  model: string;
  color: string;
  context_used_pct: number | null;
  queue_depth: number;
}

export interface RegistryEntry {
  kind: "hearsay-relay-agent";
  version: 2;
  session_id: string;
  name: string;
  purpose: string;
  model: string;
  color: string;
  pid: number;
  endpoint: string;
  cwd: string;
  started_at: string;
  hidden: boolean;
  project: string;
  heartbeat_at?: string;
}

export interface PeerInfo extends RegistryEntry {
  alive: boolean;
  agent_card?: AgentCard;
}

export interface InboundPromptRecord {
  msg_id: string;
  sender_session: string;
  sender_endpoint: string;
  sender_name: string;
  sender_cwd: string;
  prompt: string;
  hops: number;
  parent_msg_id?: string | null;
  conversation_id?: string | null;
  response_schema?: unknown | null;
  received_at: string;
  status: "open" | "replied";
  replied_at?: string;
}

export interface OutboundPromptRecord {
  msg_id: string;
  target_session: string;
  target_name: string;
  target_endpoint: string;
  parent_msg_id?: string | null;
  conversation_id?: string | null;
  response_schema?: unknown | null;
  hops: number;
  prompt: string;
  sent_at: string;
  status: "sent" | "responded" | "error";
  response?: unknown;
  error?: string | null;
  responded_at?: string;
}

export interface RelayRuntimeOptions {
  name?: string;
  project?: string;
  purpose?: string;
  model?: string;
  color?: string;
  cwd?: string;
  hidden?: boolean;
  relayDir?: string;
  maxHops?: number;
  contextUsedPct?: () => number | null;
}

export interface RelayListOptions {
  project?: string;
  include_hidden?: boolean;
  ping?: boolean;
}

export interface RelaySendArgs {
  target: string;
  prompt: string;
  parent_msg_id?: string | null;
  conversation_id?: string | null;
  response_schema?: unknown | null;
}

export interface RelaySendResult {
  msg_id: string;
  status: "sent";
  target: string;
  target_session: string;
  hops: number;
}

export interface RelayReplyArgs {
  msg_id: string;
  response: unknown;
  error?: string | null;
}

export interface RelayReplyResult {
  msg_id: string;
  status: "sent";
}

export interface RelayPromptEvent extends InboundPromptRecord {
  kind: "prompt";
  conversation_id?: string | null;
  expects_json: boolean;
}

export interface RelayResponseEvent {
  kind: "response";
  msg_id: string;
  sender_session: string;
  sender_name: string;
  response: unknown;
  error?: string | null;
  received_at: string;
}

export interface RelayRuntimeEvents {
  prompt: [RelayPromptEvent];
  response: [RelayResponseEvent];
  orphan_response: [RelayResponseEvent];
}
