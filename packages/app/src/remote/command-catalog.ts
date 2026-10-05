// Discovery only: host catalogs never supply gates or authorize an action.
import { utf8ByteLength } from "@/host/encoding";
import { parseCommand } from "./parse";
import type { RemoteCommand } from "./types";

export const CATALOG_MAX_BYTES = 256 * 1024;
export const CATALOG_MAX_CWDS = 32;
export const CATALOG_MAX_COMMANDS = 300;
export interface CatalogEntry {
  at: number;
  commands: RemoteCommand[];
}
export interface CommandCatalog {
  v: 1;
  updatedAt: number;
  latest: CatalogEntry & { cwd: string };
  byCwd: Record<string, CatalogEntry>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
// Paths are exact selection keys, not display text; reject controls rather than rewriting them.
// eslint-disable-next-line no-control-regex
const PATH_CONTROLS = /[\u0000-\u001f\u007f]/;
const cwdPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !PATH_CONTROLS.test(value);
function entry(value: unknown): CatalogEntry | undefined {
  if (
    !object(value) ||
    !timestamp(value.at) ||
    !Array.isArray(value.commands) ||
    value.commands.length > CATALOG_MAX_COMMANDS
  )
    return undefined;
  const commands = value.commands
    .map(parseCommand)
    .filter((command): command is RemoteCommand => command !== null);
  return { at: value.at, commands };
}
export function parseCommandCatalog(text: string | null | undefined): CommandCatalog | undefined {
  if (
    typeof text !== "string" ||
    text.length > CATALOG_MAX_BYTES ||
    utf8ByteLength(text) > CATALOG_MAX_BYTES
  )
    return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !object(value) ||
    value.v !== 1 ||
    !timestamp(value.updatedAt) ||
    !object(value.latest) ||
    !cwdPath(value.latest.cwd) ||
    !object(value.byCwd)
  )
    return undefined;
  const latest = entry(value.latest);
  const cwds = Object.entries(value.byCwd);
  if (!latest || cwds.length > CATALOG_MAX_CWDS) return undefined;
  const byCwd: Record<string, CatalogEntry> = Object.create(null);
  for (const [cwd, raw] of cwds) {
    const parsed = entry(raw);
    if (!cwdPath(cwd) || !parsed) return undefined;
    byCwd[cwd] = parsed;
  }
  return { v: 1, updatedAt: value.updatedAt, latest: { cwd: value.latest.cwd, ...latest }, byCwd };
}
export function selectCatalogCommands(
  catalog: CommandCatalog | undefined,
  cwd: string,
): readonly RemoteCommand[] | undefined {
  return (
    catalog &&
    (Object.hasOwn(catalog.byCwd, cwd) ? catalog.byCwd[cwd].commands : catalog.latest.commands)
  );
}

/** Prune oldest cwd entries until the phone copy fits both wire bounds. */
export function boundCommandCatalog(catalog: CommandCatalog): CommandCatalog {
  const cwds = Object.entries(catalog.byCwd)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, CATALOG_MAX_CWDS);
  const next = { ...catalog, byCwd: Object.fromEntries(cwds) };
  while (utf8ByteLength(JSON.stringify(next)) > CATALOG_MAX_BYTES && cwds.length > 0) {
    cwds.pop();
    next.byCwd = Object.fromEntries(cwds);
  }
  while (
    utf8ByteLength(JSON.stringify(next)) > CATALOG_MAX_BYTES &&
    next.latest.commands.length > 0
  ) {
    next.latest = { ...next.latest, commands: next.latest.commands.slice(0, -1) };
  }
  return next;
}
