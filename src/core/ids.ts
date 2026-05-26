import crypto from "node:crypto";

export function makeId(prefix = "msg"): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(10).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function fallbackColor(seed: string): string {
  const palette = [
    "#72F1B8",
    "#36F9F6",
    "#FF7EDB",
    "#FEDE5D",
    "#C792EA",
    "#FF8B39",
    "#4D9DE0",
    "#FFAA8B",
  ];
  const digest = crypto.createHash("sha256").update(seed).digest();
  const firstByte = digest[0] ?? 0;
  const color = palette[firstByte % palette.length];
  return color ?? "#36F9F6";
}

export function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}
