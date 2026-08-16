import type { FacetActionMap, FacetDataMap, FacetKind } from '../types';

export type Exec = (command: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** What an action compiles to: a fire-and-forget exec, a streaming terminal
 *  command, or both. */
export interface BuiltAction {
  command?: string;
  terminalCommand?: string;
}

/**
 * One orchestration system Pear can inspect and drive. Everything a facet
 * needs lives behind this interface — detection, state fetching, and action
 * commands — so adding a facet is one provider file plus a registry entry in
 * orchestration.ts (the registry's mapped type enforces the entry).
 */
export interface FacetProvider<K extends FacetKind = FacetKind> {
  readonly kind: K;
  /**
   * Shell snippet that prints the probeMarker for this kind (on its own line)
   * iff the facet is present. All providers' probes are joined with `; ` and
   * run as a single exec round-trip, so keep it silent otherwise (redirect
   * stderr) — and never let it hang.
   */
  readonly probe: string;
  /** OrchAction `type` discriminants this facet owns (globally unique). */
  readonly actionTypes: readonly FacetActionMap[K]['type'][];
  fetch(exec: Exec): Promise<FacetDataMap[K]>;
  buildAction(action: FacetActionMap[K]): BuiltAction;
}

/** The line a provider's probe must print when its facet is present. */
export function probeMarker(kind: FacetKind): string {
  return `FACET:${kind}`;
}

// ---- Shared exec/output helpers ---------------------------------------------

export function jsonLines<T>(stdout: string): T[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as T);
}

export function must(result: { code: number; stdout: string; stderr: string }, what: string): string {
  if (result.code !== 0) {
    throw new Error(`${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

// "1.83GiB / 15.6GiB" -> [used bytes, limit bytes]
const MEM_UNITS: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  KB: 1000,
  kB: 1000, // docker's SI humanizer ("docker system df") spells it lowercase
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
};
export function parseBytes(token: string): number | null {
  const m = token.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return null;
  const unit = MEM_UNITS[m[2]];
  return unit ? parseFloat(m[1]) * unit : null;
}
