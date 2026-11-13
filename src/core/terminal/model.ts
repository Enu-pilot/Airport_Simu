import { TILE_M } from '../model/catalog';
import { compareIds, sortedValues } from '../model/ids';
import type { AirportLayout, PaxZone, TerminalArea, TerminalAreaKind } from '../model/types';
import { facilityTiles } from '../layout/footprint';
import { connectedTerminal } from '../model/gates';
import { tileKey, type Vec2 } from '../geometry/vec';

/**
 * ターミナル内部の論理モデル（派生データ）。
 *
 * - エリア = ノード。同じ階で辺を共有するエリア同士、および上下移動（エスカレーター・エレベーター）と
 *   上下階で重なるエリアがつながる。
 * - 区域（landside / departure / arrival）をまたぐ移動は決められた施設でだけ許す（`canMove`）。
 * - ゲート（ターミナル外周に接する搭乗ゲート施設）は、その隣のターミナルタイルを含む
 *   出発区域のエリア（搭乗口）と到着区域のエリア（降機口）につながる。
 */

export interface AreaNode {
  id: string;
  terminalId: string;
  level: number;
  kind: TerminalAreaKind;
  zone: PaxZone;
  /** 世界座標の矩形と中心 */
  x: number;
  y: number;
  w: number;
  h: number;
  center: Vec2;
  /** 同時に滞在できる目安の人数（混雑度の分母） */
  capacity: number;
  /** 独立ゲートの搭乗待合・降機口として合成したノード（layout.terminalAreas には無い派生データ。ID は `<gateId>:dep` / `<gateId>:arr`） */
  synthetic?: true;
}

export interface AreaLink {
  to: string;
  /** 歩行距離（m）。中心 → 境界の中点 → 相手の中心 */
  lengthM: number;
  /** 上下移動の所要時間（秒）。同じ階の移動は 0 */
  travelSec: number;
  /** 経由点（境界の中点、または上下移動の重なりの中心） */
  via: Vec2;
}

export interface GateAccess {
  terminalId: string | null;
  /** 搭乗口（出発区域）と降機口（到着区域）。無ければ null */
  boarding: string | null;
  deplane: string | null;
}

/** 独立ゲート（ターミナルに隣接せず、連絡通路でつながるゲート）の接続 */
export interface GateConnector {
  gateId: string;
  terminalId: string;
  /** つなぎ先の出発区域・到着区域のエリア（アンカー）。無ければ null */
  depAnchor: string | null;
  arrAnchor: string | null;
  /** 通路の長さ（m）。直線距離 × CONNECTOR_DETOUR */
  lengthM: number;
}

export interface TerminalModel {
  areas: Record<string, AreaNode>;
  links: Record<string, AreaLink[]>;
  gates: Record<string, GateAccess>;
  /** ターミナルID → エリアID（ID 順） */
  byTerminal: Record<string, string[]>;
  /** 独立ゲートの接続（無ければ空）。描画・検証・将来の拡張（サテライト・ピープルムーバー）用 */
  connectors: GateConnector[];
}

/** 独立ゲートの搭乗待合の混雑の目安人数 */
export const GATE_LOUNGE_CAPACITY = 150;
/** 連絡通路の曲がりの係数（直線距離に掛ける） */
export const CONNECTOR_DETOUR = 1.25;

/** 1タイル（25m四方）あたりの混雑の目安人数 */
export const PAX_PER_TILE = 40;
export const WALK_SPEED_MPS = 1.3;

export function buildTerminalModel(layout: AirportLayout): TerminalModel {
  const areas: Record<string, AreaNode> = {};
  const links: Record<string, AreaLink[]> = {};
  const byTerminal: Record<string, string[]> = {};
  for (const a of sortedValues(layout.terminalAreas)) {
    if (!layout.facilities[a.terminalId]) continue;
    areas[a.id] = {
      id: a.id,
      terminalId: a.terminalId,
      level: a.level,
      kind: a.kind,
      zone: a.zone,
      x: a.origin.x,
      y: a.origin.y,
      w: a.w,
      h: a.h,
      center: { x: a.origin.x + a.w / 2, y: a.origin.y + a.h / 2 },
      capacity: Math.max(10, a.w * a.h * PAX_PER_TILE),
    };
    links[a.id] = [];
    (byTerminal[a.terminalId] ??= []).push(a.id);
  }

  for (const ids of Object.values(byTerminal)) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = areas[ids[i]!]!;
        const b = areas[ids[j]!]!;
        if (a.level === b.level) {
          const via = sharedEdgeMidpoint(a, b);
          if (via) addLink(links, a, b, via, 0);
        } else if (Math.abs(a.level - b.level) === 1) {
          const lift = isLift(a.kind) ? a : isLift(b.kind) ? b : null;
          const via = overlapCenter(a, b);
          if (lift && via) addLink(links, a, b, via, Number(layout.terminalAreas[lift.id]!.props.travelSec ?? 30));
        }
      }
    }
  }
  for (const list of Object.values(links)) list.sort((p, q) => compareIds(p.to, q.to));

  // ゲート: 隣接するターミナルタイルを含むエリア
  const gates: Record<string, GateAccess> = {};
  const connectors: GateConnector[] = [];
  for (const g of sortedValues(layout.facilities).filter((f) => f.kind === 'gate')) {
    const near = new Set([
      tileKey(g.origin.x + 1, g.origin.y),
      tileKey(g.origin.x - 1, g.origin.y),
      tileKey(g.origin.x, g.origin.y + 1),
      tileKey(g.origin.x, g.origin.y - 1),
    ]);
    const terminal = sortedValues(layout.facilities).find(
      (f) => f.kind === 'terminal' && facilityTiles(f).some((t) => near.has(tileKey(t.x, t.y))),
    );
    // 明示の接続先があり、隣接していなければ独立ゲート（連絡通路でつなぐ）。隣接していれば従来どおり
    const wanted = connectedTerminal(g, layout);
    if (wanted && terminal?.id !== wanted) {
      gates[g.id] = connectIndependentGate(layout, areas, links, byTerminal, g.id, wanted, connectors);
      continue;
    }
    const access: GateAccess = { terminalId: terminal?.id ?? null, boarding: null, deplane: null };
    if (terminal) {
      const touching = (byTerminal[terminal.id] ?? [])
        .map((id) => areas[id]!)
        .filter((a) => {
          for (let y = a.y; y < a.y + a.h; y++) for (let x = a.x; x < a.x + a.w; x++) if (near.has(tileKey(x, y))) return true;
          return false;
        });
      const rank = (a: AreaNode) => (a.kind === 'departureLobby' ? 0 : a.kind === 'waiting' ? 1 : 2);
      access.boarding =
        touching
          .filter((a) => a.zone === 'departure' && a.kind !== 'security' && !isLift(a.kind))
          .sort((p, q) => rank(p) - rank(q) || compareIds(p.id, q.id))[0]?.id ?? null;
      access.deplane =
        touching
          .filter((a) => a.zone === 'arrival' && !isLift(a.kind))
          .sort((p, q) => Number(q.kind === 'arrivalCorridor') - Number(p.kind === 'arrivalCorridor') || compareIds(p.id, q.id))[0]?.id ?? null;
    }
    gates[g.id] = access;
  }
  for (const list of Object.values(links)) list.sort((p, q) => compareIds(p.to, q.to));
  return { areas, links, gates, byTerminal, connectors };
}

/**
 * 独立ゲートの接続。ゲートのタイルに合成ノード 2 つ（搭乗待合 `<id>:dep`・降機口 `<id>:arr`）を作り、
 * 接続先ターミナルの 出発区域・到着区域のエリア（保安検査・上下移動を除く、ゲートに最も近いもの。階は問わない）へ歩行リンクでつなぐ。
 * 合成ノードは byTerminal に入れない（ゲート未定の旅客の待合・施設の選択の候補にしない）。
 */
function connectIndependentGate(
  layout: AirportLayout,
  areas: Record<string, AreaNode>,
  links: Record<string, AreaLink[]>,
  byTerminal: Record<string, string[]>,
  gateId: string,
  terminalId: string,
  connectors: GateConnector[],
): GateAccess {
  const g = layout.facilities[gateId]!;
  const center: Vec2 = { x: g.origin.x + 0.5, y: g.origin.y + 0.5 };
  const nearest = (zone: PaxZone): AreaNode | null => {
    let best: AreaNode | null = null;
    let bestD = Infinity;
    for (const id of byTerminal[terminalId] ?? []) {
      const a = areas[id]!;
      if (a.zone !== zone || a.kind === 'security' || isLift(a.kind)) continue;
      const d = Math.hypot(a.center.x - center.x, a.center.y - center.y);
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && compareIds(a.id, best.id) < 0)) {
        best = a;
        bestD = d;
      }
    }
    return best;
  };
  const depAnchor = nearest('departure');
  const arrAnchor = nearest('arrival');
  const make = (suffix: 'dep' | 'arr', anchor: AreaNode | null): string | null => {
    if (!anchor) return null;
    const id = `${gateId}:${suffix}`;
    const node: AreaNode = {
      id,
      terminalId,
      level: anchor.level,
      kind: suffix === 'dep' ? 'waiting' : 'arrivalCorridor',
      zone: suffix === 'dep' ? 'departure' : 'arrival',
      x: g.origin.x,
      y: g.origin.y,
      w: 1,
      h: 1,
      center,
      capacity: GATE_LOUNGE_CAPACITY,
      synthetic: true,
    };
    areas[id] = node;
    links[id] = [];
    const lengthM = Math.hypot(anchor.center.x - center.x, anchor.center.y - center.y) * TILE_M * CONNECTOR_DETOUR;
    const via = { x: (anchor.center.x + center.x) / 2, y: (anchor.center.y + center.y) / 2 };
    links[id]!.push({ to: anchor.id, lengthM, travelSec: 0, via });
    links[anchor.id]!.push({ to: id, lengthM, travelSec: 0, via });
    return id;
  };
  const boarding = make('dep', depAnchor);
  const deplane = make('arr', arrAnchor);
  const anchor = depAnchor ?? arrAnchor;
  connectors.push({
    gateId,
    terminalId,
    depAnchor: depAnchor?.id ?? null,
    arrAnchor: arrAnchor?.id ?? null,
    lengthM: anchor ? Math.hypot(anchor.center.x - center.x, anchor.center.y - center.y) * TILE_M * CONNECTOR_DETOUR : 0,
  });
  return { terminalId, boarding, deplane };
}

const isLift = (k: TerminalAreaKind): boolean => k === 'escalator' || k === 'elevator';

function addLink(links: Record<string, AreaLink[]>, a: AreaNode, b: AreaNode, via: Vec2, travelSec: number): void {
  const d = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) * TILE_M;
  const lengthM = d(a.center, via) + d(via, b.center);
  links[a.id]!.push({ to: b.id, lengthM, travelSec, via });
  links[b.id]!.push({ to: a.id, lengthM, travelSec, via });
}

/** 同じ階の2つの矩形が辺を共有していれば、共有部分の中点 */
function sharedEdgeMidpoint(a: AreaNode, b: AreaNode): Vec2 | null {
  const ox0 = Math.max(a.x, b.x);
  const ox1 = Math.min(a.x + a.w, b.x + b.w);
  const oy0 = Math.max(a.y, b.y);
  const oy1 = Math.min(a.y + a.h, b.y + b.h);
  if ((a.y + a.h === b.y || b.y + b.h === a.y) && ox1 - ox0 >= 1) return { x: (ox0 + ox1) / 2, y: a.y + a.h === b.y ? b.y : a.y };
  if ((a.x + a.w === b.x || b.x + b.w === a.x) && oy1 - oy0 >= 1) return { x: a.x + a.w === b.x ? b.x : a.x, y: (oy0 + oy1) / 2 };
  return null;
}

function overlapCenter(a: AreaNode, b: AreaNode): Vec2 | null {
  const x0 = Math.max(a.x, b.x);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y0 = Math.max(a.y, b.y);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } : null;
}

/**
 * 区域をまたぐ移動の規則。
 * - 同じ区域内は自由
 * - 一般区域 → 出発区域は「保安検査場に入る」ときだけ（保安検査を通らずに出発区域へ入れない）
 * - 到着区域 → 一般区域は「手荷物受取所から出る」か「出口に入る」ときだけ
 * - それ以外（出発 ↔ 到着、出発 → 一般など）は不可
 */
export function canMove(from: AreaNode, to: AreaNode): boolean {
  if (from.zone === to.zone) return true;
  if (from.zone === 'landside' && to.zone === 'departure') return to.kind === 'security';
  if (from.zone === 'arrival' && to.zone === 'landside') return from.kind === 'baggageClaim' || to.kind === 'exit';
  return false;
}

export function areaRectTiles(a: TerminalArea): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = a.origin.y; y < a.origin.y + a.h; y++) for (let x = a.origin.x; x < a.origin.x + a.w; x++) out.push({ x, y });
  return out;
}
