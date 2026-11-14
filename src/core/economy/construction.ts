import { distance } from '../geometry/vec';
import { TILE_M } from '../model/catalog';
import { isFreeRunway, type AirportLayout, type Facility, type TerminalArea } from '../model/types';
import type { UnitKind } from '../sim/types';
import { BALANCE } from './balance';
import { post, type CompanyState } from './company';
import { elevationOf, levelOf } from '../model/levels';

/**
 * 建設費（docs/14_management_rules.md §2）。
 *
 * レイアウトの「資産額」= 計画中（planned）以外の全エンティティの建設費の合計。
 * 編集の前後で資産額が増えた分を建設費として支払い、減った分は refundRate だけ戻る。
 * 計画中の施設は費用がかからず、建設中・運用中に変えた時点で支払う。
 */

const C = BALANCE.construction;

const VEHICLE_PROPS: [string, UnitKind][] = [
  ['tugs', 'tug'],
  ['beltLoaders', 'beltLoader'],
  ['baggageTractors', 'baggageTractor'],
  ['fuelTrucks', 'fuelTruck'],
  ['cateringTrucks', 'cateringTruck'],
  ['cleaningVans', 'cleaningVan'],
  ['apronBuses', 'apronBus'],
];

const num = (v: unknown): number => Math.max(0, Number(v ?? 0) || 0);

export function facilityValue(f: Facility): number {
  if (f.buildState === 'planned') return 0;
  const tiles = f.w * f.h;
  const perTile = C.perTile[f.kind];
  if (perTile !== undefined) return tiles * perTile * (f.kind === 'terminal' ? Math.max(1, num(f.props.levels)) : 1);
  if (f.kind === 'staffParking') return tiles * C.access.staffParkingPerTile;
  if (f.kind === 'taxiStand' || f.kind === 'busStop' || f.kind === 'railStation' || f.kind === 'hotel') return C.access[f.kind];
  let v = C.facility[f.kind] ?? 0;
  if (f.kind === 'gate' && f.props.jetBridge) v += C.jetBridge;
  if (f.kind === 'gseBase') for (const [prop, kind] of VEHICLE_PROPS) v += num(f.props[prop]) * (C.vehicle[kind] ?? 0);
  return v;
}

export function areaValue(a: TerminalArea): number {
  const units = num(a.props.counters ?? a.props.lanes ?? a.props.fixtures ?? a.props.belts ?? 0);
  const unit = C.areaUnit[a.kind] ?? 0;
  // 設備の数を持たないエリア（店舗・上下移動など）は1つとして数える
  const count = a.kind === 'checkIn' || a.kind === 'security' || a.kind === 'restroom' || a.kind === 'baggageClaim' ? units : 1;
  return a.w * a.h * C.areaPerTile + unit * count;
}

/** エンティティごとの建設費（ID → cr） */
export function layoutItems(layout: AirportLayout): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of Object.values(layout.runways)) {
    if (r.buildState === 'planned') continue;
    if (isFreeRunway(r)) {
      // 自由形: 実長（m）→ タイル。肩の費用は加えない（ゲームの単純化）
      out[r.id] = Math.round((r.lengthM / TILE_M) * C.runwayPerTile * (r.surfaceWidthM / 30));
      continue;
    }
    const tiles = r.length * (r.heading % 90 === 0 ? 1 : Math.SQRT2);
    out[r.id] = Math.round(tiles * C.runwayPerTile * (r.surfaceWidthM / 30));
  }
  for (const e of Object.values(layout.taxiways)) {
    if (e.buildState === 'planned') continue;
    const a = layout.taxiNodes[e.from];
    const b = layout.taxiNodes[e.to];
    if (!a || !b) continue;
    out[e.id] = Math.round(distance(a.pos, b.pos) * C.taxiwayPerTile[e.widthClass]);
  }
  for (const e of Object.values(layout.roads)) {
    if (e.buildState === 'planned') continue;
    const a = layout.roadNodes[e.from];
    const b = layout.roadNodes[e.to];
    if (!a || !b) continue;
    const levelA = levelOf(a);
    const levelB = levelOf(b);
    const verticalTiles = Math.abs(elevationOf(a) - elevationOf(b)) / TILE_M;
    const lengthTiles = Math.hypot(distance(a.pos, b.pos), verticalTiles);
    const unitCost = e.roadClass === 'fuel' ? C.fuelPipePerTile : e.roadClass === 'rail' ? C.access.railPerTile : C.roadPerTile;
    const multiplier = e.roadClass === 'fuel' ? 1 : Math.min(levelA, levelB) < 0 ? C.tunnelMultiplier : Math.max(levelA, levelB) > 0 ? C.elevatedMultiplier : 1;
    out[e.id] = Math.round(lengthTiles * unitCost * multiplier);
  }
  for (const link of Object.values(layout.terminalLinks ?? {})) {
    if (link.buildState === 'planned') continue;
    const perTile = link.kind === 'movingWalkway' ? C.movingWalkwayPerTile : C.terminalWalkwayPerTile;
    out[link.id] = Math.round((link.distanceM / TILE_M) * perTile);
  }
  // 購入した土地
  if (layout.site.purchased) out['land'] = layout.site.purchased * C.landPerTile;
  for (const s of Object.values(layout.stands)) if (s.buildState !== 'planned') out[s.id] = C.stand[s.size];
  for (const f of Object.values(layout.facilities)) {
    const v = facilityValue(f);
    if (v > 0) out[f.id] = v;
  }
  for (const a of Object.values(layout.terminalAreas)) out[a.id] = areaValue(a);
  return out;
}

/** レイアウトの資産額 */
export function layoutValue(layout: AirportLayout): number {
  return Object.values(layoutItems(layout)).reduce((s, v) => s + v, 0);
}

/**
 * 空港の規模による割増係数 = min(上限, 1 + 0.5 × 資産額 / 1億cr)。
 * 新しい建設費・払い戻し・施設維持費に掛かる（大きな空港ほど拡張に費用がかかる）。
 */
export function scaleFactor(layout: AirportLayout): number {
  return Math.min(BALANCE.scale.max, 1 + BALANCE.scale.perValue * layoutValue(layout));
}

/**
 * 編集による支払額（正 = 支払い、負 = 払い戻し）。
 * エンティティごとに差を取り、増えた分は全額、減った分は refundRate だけ戻る。合計に編集前の規模係数を掛ける。
 */
export function constructionCost(before: AirportLayout, after: AirportLayout): number {
  const a = layoutItems(before);
  const b = layoutItems(after);
  let cost = 0;
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[id] ?? 0) - (a[id] ?? 0);
    cost += d > 0 ? d : d * C.refundRate;
  }
  return Math.round(cost * scaleFactor(before));
}

export type ChargeResult = { ok: true; cost: number } | { ok: false; reason: 'INSUFFICIENT_FUNDS'; cost: number };

/**
 * 編集の建設費を支払う。資金が足りなければ編集を受け付けない（払い戻しはいつでも可）。
 */
export function chargeConstruction(c: CompanyState, before: AirportLayout, after: AirportLayout): ChargeResult {
  const cost = constructionCost(before, after);
  if (cost > 0 && c.cash < cost) return { ok: false, reason: 'INSUFFICIENT_FUNDS', cost };
  post(c, 'construction', -cost);
  return { ok: true, cost };
}
