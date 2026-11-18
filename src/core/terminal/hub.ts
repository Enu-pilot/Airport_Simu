import type { AirportLayout } from '../model/types';
import { canMove, WALK_SPEED_MPS, type TerminalModel } from './model';
import { areaServerCount, serviceSecPerPax } from './capacity';

export type TransferKind = 'DD' | 'DI' | 'ID' | 'II';
export const TRANSFER_KINDS: readonly TransferKind[] = ['DD', 'DI', 'ID', 'II'];

/** 乗継の種類: 到着便・出発便の国内（D）/国際（I）の組み合わせ */
export function transferKindOf(arrIntl: boolean, depIntl: boolean): TransferKind {
  return `${arrIntl ? 'I' : 'D'}${depIntl ? 'I' : 'D'}` as TransferKind;
}

export interface HubKindStats {
  /** 空港の MCT（秒）: 使えるゲートの組の最大値。組がなければ null（MCT_UNAVAILABLE） */
  max: number | null;
  /** 使えるゲートの組の MCT の中央値（秒） */
  median: number | null;
  /** 使えるゲートの組の数 */
  pairs: number;
}

export interface HubAnalysis {
  /** 種類ごとの空港 MCT（秒）。null は MCT_UNAVAILABLE（その種類の乗継は計画しない） */
  mct: Record<TransferKind, number | null>;
  byKind: Record<TransferKind, HubKindStats>;
  /** ゲートの組ごとの MCT（秒）。キーは `${到着ゲート}>${出発ゲート}:${種類}` */
  pairMct: Map<string, number>;
}

/** 境界の工程（審査・乗継保安検査）に入るエリア */
const BOUNDARY_KINDS = new Set(['transferSecurity', 'emigration', 'immigration']);
/** 降機の目安（10 分）と余裕（5 分）。搭乗締切の前倒しは既存の締切（出発 10 分前） */
const DEPLANE_SEC = 10 * 60;
const BUFFER_SEC = 5 * 60;
const DEADLINE_BEFORE_SEC = 10 * 60;
const MIN_MCT_SEC = 30 * 60;

function serversOfArea(layout: AirportLayout, areaId: string): number {
  const a = layout.terminalAreas[areaId];
  if (!a) return 0;
  return areaServerCount(a.props);
}

/** 境界の工程の目安: 処理時間 × 5 人 / 窓口数 + 300 秒（窓口 0 なら通れない） */
function boundarySec(layout: AirportLayout, areaId: string): number {
  const a = layout.terminalAreas[areaId]!;
  const servers = serversOfArea(layout, areaId);
  if (servers === 0) return Infinity;
  return (serviceSecPerPax(a.kind, a.props) * 5) / servers + 300;
}

const cache = new WeakMap<TerminalModel, HubAnalysis>();

/**
 * ハブ解析（フェーズ 4 §5.2）: 到着ゲートごとに 1 回、canMove の規則で全エリアへの
 * 最短所要時間を求め、ゲートの組ごとの最小乗継時間（MCT）を決める。
 * 結果は TerminalModel ごとに保持し、配置が変わったときだけ作り直す。
 */
export function analyzeHub(layout: AirportLayout, model: TerminalModel): HubAnalysis {
  const hit = cache.get(model);
  if (hit) return hit;

  const pairMct = new Map<string, number>();
  const gates = Object.entries(model.gates).filter(([, g]) => g.terminalId);
  // 到着側の起点: 国内は降機口、国際は国際降機口。両方あるゲートは起点が 2 つ
  for (const [arrGateId, arrGate] of gates) {
    const starts: { intl: boolean; area: string }[] = [];
    if (arrGate.deplane) starts.push({ intl: false, area: arrGate.deplane });
    if (arrGate.deplaneIntl) starts.push({ intl: true, area: arrGate.deplaneIntl });
    for (const start of starts) {
      const dist = dijkstra(model, layout, start.area);
      for (const [depGateId, depGate] of gates) {
        for (const depIntl of [false, true]) {
          const goal = depIntl ? depGate.boardingIntl : depGate.boarding;
          if (!goal) continue;
          const leg = dist.get(goal);
          if (leg === undefined || !Number.isFinite(leg)) continue;
          const kind = transferKindOf(start.intl, depIntl);
          const raw = leg + DEPLANE_SEC + DEADLINE_BEFORE_SEC + BUFFER_SEC;
          const mct = Math.max(MIN_MCT_SEC, Math.ceil(raw / 300) * 300);
          pairMct.set(`${arrGateId}>${depGateId}:${kind}`, mct);
        }
      }
    }
  }

  const mct = {} as Record<TransferKind, number | null>;
  const byKind = {} as Record<TransferKind, HubKindStats>;
  for (const kind of TRANSFER_KINDS) {
    const values = [...pairMct.entries()].filter(([k]) => k.endsWith(`:${kind}`)).map(([, v]) => v).sort((a, b) => a - b);
    mct[kind] = values.length > 0 ? values[values.length - 1]! : null;
    byKind[kind] = {
      max: mct[kind],
      median: values.length > 0 ? values[Math.floor((values.length - 1) / 2)]! : null,
      pairs: values.length,
    };
  }
  const result: HubAnalysis = { mct, byKind, pairMct };
  cache.set(model, result);
  return result;
}

/** 起点エリアから全エリアへの最短所要時間（歩行 + 移動時間 + 境界の工程の目安） */
function dijkstra(model: TerminalModel, layout: AirportLayout, from: string): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  const done = new Set<string>();
  const open: string[] = [from];
  while (open.length > 0) {
    open.sort((a, b) => dist.get(a)! - dist.get(b)! || (a < b ? -1 : 1));
    const cur = open.shift()!;
    if (done.has(cur)) continue;
    done.add(cur);
    const c = dist.get(cur)!;
    const node = model.areas[cur]!;
    for (const link of model.links[cur] ?? []) {
      const next = model.areas[link.to]!;
      if (!canMove(node, next)) continue;
      // 乗継客は一般区域へ出ない（フェーズ 4 §5.4 の手順どおり、空側だけで移る）。
      // 一般区域経由の経路や出発保安検査への経路は MCT の対象にしない
      if (next.zone === 'landside' || next.kind === 'security') continue;
      let nc = c + link.lengthM / WALK_SPEED_MPS + link.travelSec;
      if (BOUNDARY_KINDS.has(next.kind)) {
        const b = boundarySec(layout, next.id);
        if (!Number.isFinite(b)) continue;
        nc += b;
      }
      if (nc < (dist.get(next.id) ?? Infinity)) {
        dist.set(next.id, nc);
        open.push(next.id);
      }
    }
  }
  return dist;
}
