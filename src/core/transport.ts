import fs from "node:fs";
import net from "node:net";
import type { RelayReplyEnvelope } from "./types.js";

export const DEFAULT_LINE_CAP_BYTES = 1024 * 1024;

export async function bindEndpoint(
  endpoint: string,
  connHandler: (socket: net.Socket) => void,
): Promise<net.Server> {
  if (process.platform !== "win32" && fs.existsSync(endpoint)) {
    const verdict = await probeStaleSocket(endpoint);
    if (verdict === "in_use") {
      throw new Error(`relay endpoint already in use: ${endpoint}`);
    }
    try {
      fs.unlinkSync(endpoint);
    } catch {
      // best effort
    }
  }

  return await new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer(connHandler);
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

export function readOneLine(socket: net.Socket, capBytes = DEFAULT_LINE_CAP_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      fn();
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > capBytes) {
        settle(() => reject(new Error("line too large")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        settle(() => resolve(buffer.slice(0, newline)));
      }
    };

    const onError = (error: Error) => settle(() => reject(error));
    const onClose = () => settle(() => reject(new Error("connection closed before line received")));

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export async function sendEnvelope(endpoint: string, envelope: unknown): Promise<RelayReplyEnvelope> {
  return await new Promise<RelayReplyEnvelope>((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint });
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      reject(error);
    };

    socket.once("error", fail);
    socket.once("connect", async () => {
      try {
        socket.write(`${JSON.stringify(envelope)}\n`);
        const line = await readOneLine(socket);
        const parsed = JSON.parse(line) as unknown;
        if (!isRelayReply(parsed)) {
          fail(new Error("malformed relay reply"));
          return;
        }
        try {
          socket.end();
        } catch {
          // ignore
        }
        if (settled) return;
        settled = true;
        if (parsed.type === "nack") {
          reject(new Error(parsed.error || "nack"));
        } else {
          resolve(parsed);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export function writeAck(socket: net.Socket, msgId: string): void {
  writeLineAndEnd(socket, { type: "ack", msg_id: msgId });
}

export function writeNack(socket: net.Socket, msgId: string, error: string): void {
  writeLineAndEnd(socket, { type: "nack", msg_id: msgId, error });
}

export function writePong(socket: net.Socket, payload: RelayReplyEnvelope): void {
  writeLineAndEnd(socket, payload);
}

async function probeStaleSocket(endpoint: string): Promise<"in_use" | "stale"> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ path: endpoint });
    let settled = false;

    const finish = (verdict: "in_use" | "stale") => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(verdict);
    };

    const timer = setTimeout(() => finish("stale"), 250);
    try {
      timer.unref();
    } catch {
      // ignore
    }

    socket.once("connect", () => {
      clearTimeout(timer);
      finish("in_use");
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish("stale");
    });
  });
}

function writeLineAndEnd(socket: net.Socket, payload: unknown): void {
  try {
    socket.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // ignore
  }
  try {
    socket.end();
  } catch {
    // ignore
  }
}

function isRelayReply(value: unknown): value is RelayReplyEnvelope {
  if (!value || typeof value !== "object") return false;
  const reply = value as Partial<RelayReplyEnvelope>;
  if (reply.type === "ack") return typeof reply.msg_id === "string";
  if (reply.type === "nack") return typeof reply.msg_id === "string" && typeof reply.error === "string";
  if (reply.type === "pong") return typeof reply.msg_id === "string" && typeof reply.agent_card === "object" && reply.agent_card !== null;
  return false;
}
