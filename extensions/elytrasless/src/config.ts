import os from "node:os";
import path from "node:path";

export type ElytraslessConfig = {
  storePath: string;
  dataRoot: string;
  injectUserContext: boolean;
  injectTeamContext: boolean;
  injectProjectContext: boolean;
  auditLogPath: string;
  maxInjectedChars: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveDefaultStorePath(): string {
  const envPath = normalizeOptionalString(process.env.CONTROL_TOWER_STORE_PATH);
  if (envPath) {
    return envPath;
  }
  return path.join(os.homedir(), ".openclaw", "control-tower-store.json");
}

function resolveDefaultDataRoot(): string {
  const envPath = normalizeOptionalString(process.env.ELYTRAS_DATA_ROOT);
  if (envPath) {
    return envPath;
  }
  return path.join(os.homedir(), ".openclaw", "elytras");
}

export function normalizeElytraslessConfig(
  value: unknown,
  resolvePath: (input: string) => string,
): ElytraslessConfig {
  const record = isRecord(value) ? value : {};
  const dataRoot = normalizeOptionalString(record.dataRoot)
    ? resolvePath(String(record.dataRoot))
    : resolveDefaultDataRoot();
  return {
    storePath: normalizeOptionalString(record.storePath)
      ? resolvePath(String(record.storePath))
      : resolveDefaultStorePath(),
    dataRoot,
    injectUserContext: normalizeBoolean(record.injectUserContext, true),
    injectTeamContext: normalizeBoolean(record.injectTeamContext, true),
    injectProjectContext: normalizeBoolean(record.injectProjectContext, true),
    auditLogPath: normalizeOptionalString(record.auditLogPath)
      ? resolvePath(String(record.auditLogPath))
      : path.join(dataRoot, ".elytrasless", "events.jsonl"),
    maxInjectedChars: normalizePositiveNumber(record.maxInjectedChars) ?? 8000,
  };
}
