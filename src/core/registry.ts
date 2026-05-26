import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RegistryEntry } from "./types.js";

export function defaultRelayDir(): string {
  return process.env.HEARSAY_RELAY_DIR || path.join(os.homedir(), ".hearsay", "relay");
}

export function makeEndpoint(relayDir: string, sessionId: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\hearsay-relay-${sessionId}`;
  }
  return path.join(relayDir, "sockets", `${sessionId}.sock`);
}

export function ensureRelayDirs(relayDir: string, project: string): void {
  fs.mkdirSync(projectAgentsDir(relayDir, project), { recursive: true });
  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(relayDir, "sockets"), { recursive: true });
    try {
      fs.chmodSync(relayDir, 0o700);
    } catch {
      // Best effort only. Some filesystems do not support chmod.
    }
  }
}

export function projectAgentsDir(relayDir: string, project: string): string {
  assertSafeProject(project);
  return path.join(relayDir, "projects", project, "agents");
}

export function registryFilePath(relayDir: string, project: string, name: string): string {
  return path.join(projectAgentsDir(relayDir, project), `${encodeURIComponent(name)}.json`);
}

export function writeRegistryAtomic(relayDir: string, entry: RegistryEntry): string {
  ensureRelayDirs(relayDir, entry.project);
  const finalPath = registryFilePath(relayDir, entry.project, entry.name);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

export function removeRegistryEntry(relayDir: string, project: string, name: string): void {
  try {
    fs.unlinkSync(registryFilePath(relayDir, project, name));
  } catch {
    // best effort
  }
}

export function readProjectNames(relayDir: string): string[] {
  const root = path.join(relayDir, "projects");
  try {
    return fs.readdirSync(root).filter((name) => {
      try {
        return fs.statSync(path.join(root, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function readRegistryEntries(relayDir: string, project: string): RegistryEntry[] {
  const dir = projectAgentsDir(relayDir, project);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const entries: RegistryEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (isRegistryEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed or racing writes.
    }
  }
  return entries;
}

export function readRegistryEntriesAcrossProjects(relayDir: string): RegistryEntry[] {
  return readProjectNames(relayDir).flatMap((project) => readRegistryEntries(relayDir, project));
}

export function pruneDeadEntries(relayDir: string, project: string): RegistryEntry[] {
  const live: RegistryEntry[] = [];
  for (const entry of readRegistryEntries(relayDir, project)) {
    if (isPidAlive(entry.pid)) {
      live.push(entry);
    } else {
      removeRegistryEntry(relayDir, entry.project, entry.name);
    }
  }
  return live;
}

export function pruneDeadEntriesAcrossProjects(relayDir: string): RegistryEntry[] {
  return readProjectNames(relayDir).flatMap((project) => pruneDeadEntries(relayDir, project));
}

export function resolveUniqueName(relayDir: string, project: string, desiredName: string): string {
  const liveNames = new Set(pruneDeadEntries(relayDir, project).map((entry) => entry.name));
  if (!liveNames.has(desiredName)) return desiredName;

  let suffix = 2;
  while (liveNames.has(`${desiredName}${suffix}`)) suffix += 1;
  return `${desiredName}${suffix}`;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    return code === "EPERM";
  }
}

function isRegistryEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<RegistryEntry>;
  return (
    entry.kind === "hearsay-relay-agent" &&
    entry.version === 2 &&
    typeof entry.session_id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.purpose === "string" &&
    typeof entry.model === "string" &&
    typeof entry.color === "string" &&
    typeof entry.pid === "number" &&
    typeof entry.endpoint === "string" &&
    typeof entry.cwd === "string" &&
    typeof entry.started_at === "string" &&
    typeof entry.explicit === "boolean" &&
    typeof entry.project === "string"
  );
}

function assertSafeProject(project: string): void {
  if (!project || project === "*" || project.includes("/") || project.includes("\\") || project === "." || project === "..") {
    throw new Error(`invalid relay project name: ${JSON.stringify(project)}`);
  }
}
