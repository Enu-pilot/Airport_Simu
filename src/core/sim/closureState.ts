import { compareIds } from '../model/ids';
import type { SimState } from './types';

export type ClosureKind = 'taxiways' | 'stands' | 'gates';
export type ClosureReasonMap = Record<ClosureKind, Record<string, string[]>>;

const EMPTY = (): ClosureReasonMap => ({ taxiways: {}, stands: {}, gates: {} });
const sorted = (values: string[]) => [...new Set(values)].sort(compareIds);

function disruptionTargets(kind: ClosureKind, disruptionKind: string): boolean {
  if (kind === 'taxiways') return disruptionKind === 'taxiwayClosed' || disruptionKind === 'maintenance';
  if (kind === 'stands') return disruptionKind === 'standClosed' || disruptionKind === 'maintenance';
  return disruptionKind === 'gateFailure' || disruptionKind === 'maintenance';
}

/** 旧保存の閉鎖配列を理由台帳へ移行し、複数原因を独立して解除できるようにする。 */
export function ensureClosureReasons(state: SimState): ClosureReasonMap {
  if (state.closureReasons) return state.closureReasons;
  const reasons = EMPTY();
  for (const kind of ['taxiways', 'stands', 'gates'] as const) {
    for (const id of state.closures[kind]) {
      const sources = state.disruptions
        .filter((d) => d.status === 'active' && d.targetId === id && disruptionTargets(kind, d.kind))
        .map((d) => `disruption:${d.id}`);
      reasons[kind][id] = sources.length ? sorted(sources) : ['legacy'];
    }
  }
  // Keep legacy states byte-compatible until there is an active closure to track.
  if ((['taxiways', 'stands', 'gates'] as const).some((kind) => Object.keys(reasons[kind]).length > 0)) state.closureReasons = reasons;
  return reasons;
}

export function addClosureReason(state: SimState, kind: ClosureKind, id: string, reason: string): void {
  const map = ensureClosureReasons(state);
  state.closureReasons = map;
  map[kind][id] = sorted([...(map[kind][id] ?? []), reason]);
  if (!state.closures[kind].includes(id)) state.closures[kind] = sorted([...state.closures[kind], id]);
}

export function removeClosureReason(state: SimState, kind: ClosureKind, id: string, reason: string): void {
  const map = ensureClosureReasons(state);
  if (!map[kind][id]) return;
  const remaining = (map[kind][id] ?? []).filter((entry) => entry !== reason);
  if (remaining.length) map[kind][id] = remaining;
  else {
    delete map[kind][id];
    state.closures[kind] = state.closures[kind].filter((entry) => entry !== id);
  }
  if (!(['taxiways', 'stands', 'gates'] as const).some((closureKind) => Object.keys(map[closureKind]).length > 0)) delete state.closureReasons;
}

export function closureReasonsFor(state: SimState, kind: ClosureKind, id: string): string[] {
  return ensureClosureReasons(state)[kind][id] ?? [];
}

export function hydrateClosureReasons(state: SimState): void {
  ensureClosureReasons(state);
}
