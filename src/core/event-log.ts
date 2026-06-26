import fs from "node:fs";
import path from "node:path";
import { makeId, nowIso } from "./ids.js";
import { ensureRelayDirs } from "./registry.js";

export const RELAY_EVENT_LOG_SCHEMA_VERSION = 1;

export type RelayEventName =
  | "runtime_started"
  | "runtime_stopped"
  | "prompt_send_attempt"
  | "prompt_send_acked"
  | "prompt_send_failed"
  | "prompt_received"
  | "followup_send_attempt"
  | "followup_send_acked"
  | "followup_send_failed"
  | "followup_received"
  | "response_send_attempt"
  | "response_send_acked"
  | "response_send_failed"
  | "response_received"
  | "orphan_response_received";

export interface RelayEventPeerSnapshot {
  name: string;
  project?: string | null;
  session_id: string;
  endpoint?: string;
  cwd?: string;
  model?: string;
}

export interface RelayEventLogEntry {
  schema_version: 1;
  event_id: string;
  observed_at: string;
  project: string;
  observer: RelayEventPeerSnapshot;
  event: RelayEventName;
  msg_id?: string;
  parent_msg_id?: string | null;
  conversation_id?: string | null;
  hops?: number;
  from?: RelayEventPeerSnapshot;
  to?: RelayEventPeerSnapshot;
  prompt?: string;
  message?: string;
  response?: unknown;
  error?: string | null;
  orphan?: boolean;
  status?: string;
  expects_json?: boolean;
}

export type RelayEventLogInput = Omit<RelayEventLogEntry, "schema_version" | "event_id" | "observed_at"> & {
  event_id?: string;
  observed_at?: string;
};

export function relayEventLogPath(relayDir: string, project: string): string {
  assertSafeProject(project);
  return path.join(relayDir, "projects", project, "events.jsonl");
}

export function makeRelayEventLogEntry(input: RelayEventLogInput): RelayEventLogEntry {
  return {
    schema_version: RELAY_EVENT_LOG_SCHEMA_VERSION,
    event_id: input.event_id ?? makeId("evt"),
    observed_at: input.observed_at ?? nowIso(),
    ...input,
  };
}

export function appendRelayEventLog(relayDir: string, input: RelayEventLogInput): RelayEventLogEntry {
  const entry = makeRelayEventLogEntry(input);
  ensureRelayDirs(relayDir, entry.project);
  fs.appendFileSync(relayEventLogPath(relayDir, entry.project), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function readRelayEventLog(relayDir: string, project: string): RelayEventLogEntry[] {
  const file = relayEventLogPath(relayDir, project);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const events: RelayEventLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRelayEventLogEntry(parsed)) events.push(parsed);
    } catch {
      // Tolerate malformed or partially written lines.
    }
  }
  return events;
}

function isRelayEventLogEntry(value: unknown): value is RelayEventLogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RelayEventLogEntry>;
  return (
    entry.schema_version === RELAY_EVENT_LOG_SCHEMA_VERSION &&
    typeof entry.event_id === "string" &&
    typeof entry.observed_at === "string" &&
    typeof entry.project === "string" &&
    typeof entry.event === "string" &&
    isPeerSnapshot(entry.observer)
  );
}

function isPeerSnapshot(value: unknown): value is RelayEventPeerSnapshot {
  if (!value || typeof value !== "object") return false;
  const peer = value as Partial<RelayEventPeerSnapshot>;
  return typeof peer.name === "string" && typeof peer.session_id === "string";
}

function assertSafeProject(project: string): void {
  if (!project || project === "*" || project.includes("/") || project.includes("\\") || project === "." || project === "..") {
    throw new Error(`invalid relay project name: ${JSON.stringify(project)}`);
  }
}
