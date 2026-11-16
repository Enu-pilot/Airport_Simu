import { FACILITY_SPECS } from '../model/catalog';
import { compareIds } from '../model/ids';
import type { AirportLayout, NetNode } from '../model/types';
import { distPointSegment, distance, pointInPolygon, type Vec2 } from '../geometry/vec';
import { mapToWorld } from '../geometry/frames';
import { facilityLevel } from '../model/levels';
import { facilityDims, standDims } from './footprint';
import { runwayPolygon } from './runway';

/** 表示状態（描画と同じ条件で選択候補を絞る）。省略時は従来どおり、階層・内部表示を見ない */
export interface PickView {
  mapLevel: number | 'all';
  interior: { shown: boolean; level: number };
}

/**
 * 世界座標の点にあるエンティティの候補を、優先順に並べて返す（重複なし）。
 * 重なっている場合は小さく上にあるものを優先する:
 * ノード > ゲート > スポット > 建物 > 誘導路 > 道路 > 滑走路 > エリア（エプロン等）
 *
 * `view` を渡すと描画と同じ条件で絞る（1-03）:
 *  1. 内部表示がオンのとき: 階 floorIndex === interior.level の内部設備 → その階のターミナルエリア → 通常の候補
 *  2. 通常の候補: 道路のノード・辺・独立施設は表示中の階のもの（mapLevel 'all' なら全部）。滑走路・誘導路・スポットは常に候補
 *  3. 内部表示がオフのとき、建物内設備（parentFacilityId）は候補にしない
 */
export function pickCandidatesAt(layout: AirportLayout, world: Vec2, view?: PickView): string[] {
  // ノード・エッジはタイル中心が基準なので、World フレームに直す
  const p = mapToWorld(world);
  const inRect = (o: Vec2, w: number, h: number) => world.x >= o.x && world.x < o.x + w && world.y >= o.y && world.y < o.y + h;
  const sorted = (ids: string[]) => ids.sort(compareIds).reverse();
  const out: string[] = [];
  const push = (ids: string[]) => {
    for (const id of sorted(ids)) if (!out.includes(id)) out.push(id);
  };
  const level = view?.mapLevel;
  const levelOk = (l: number) => level === undefined || level === 'all' || l === level;

  if (view?.interior.shown) {
    push(
      Object.values(layout.facilities)
        .filter((f) => f.parentFacilityId && (f.floorIndex ?? 0) === view.interior.level)
        .filter((f) => {
          const d = facilityDims(f);
          return inRect(f.origin, d.w, d.h);
        })
        .map((f) => f.id),
    );
    const area = pickTerminalArea(layout, world, view.interior.level);
    if (area) out.push(area);
  }

  push(
    [...Object.values(layout.taxiNodes), ...Object.values(layout.roadNodes).filter((n) => levelOk(n.level ?? 0))]
      .filter((n) => distance(n.pos, p) <= 0.45)
      .map((n) => n.id),
  );

  const facilities = Object.values(layout.facilities).filter((f) => (view ? !f.parentFacilityId && levelOk(facilityLevel(f)) : true));
  push(facilities.filter((f) => f.kind === 'gate' && inRect(f.origin, 1, 1)).map((f) => f.id));

  push(
    Object.values(layout.stands)
      .filter((s) => {
        const d = standDims(s);
        return inRect(s.origin, d.w, d.h);
      })
      .map((s) => s.id),
  );

  const inFacility = (layer: 'building' | 'area' | 'apron') =>
    facilities
      .filter((f) => FACILITY_SPECS[f.kind].layer === layer)
      .filter((f) => {
        const d = facilityDims(f);
        return inRect(f.origin, d.w, d.h);
      })
      .map((f) => f.id);
  push(inFacility('building'));

  const edgeHit = (nodes: AirportLayout['taxiNodes'], edges: Record<string, { id: string; from: string; to: string }>, visible: (a: NetNode, b: NetNode) => boolean) =>
    Object.values(edges)
      .filter((e) => {
        const a = nodes[e.from];
        const b = nodes[e.to];
        return !!a && !!b && visible(a, b) && distPointSegment(p, a.pos, b.pos).dist <= 0.5;
      })
      .map((e) => e.id);
  push(edgeHit(layout.taxiNodes, layout.taxiways, () => true));
  push(edgeHit(layout.roadNodes, layout.roads, (a, b) => levelOk(a.level ?? 0) || levelOk(b.level ?? 0)));

  push(
    Object.values(layout.runways)
      .filter((r) => pointInPolygon(p, runwayPolygon(r)))
      .map((r) => r.id),
  );

  push([...inFacility('area'), ...inFacility('apron')]);
  return out;
}

/** 世界座標の点にあるエンティティを選ぶ（候補の先頭）。`view` を省略すると従来どおり */
export function pickAt(layout: AirportLayout, world: Vec2, view?: PickView): string | null {
  return pickCandidatesAt(layout, world, view)[0] ?? null;
}

/** 指定階のターミナル内エリアを選ぶ（小さいものを優先） */
export function pickTerminalArea(layout: AirportLayout, world: Vec2, level: number): string | null {
  const hits = Object.values(layout.terminalAreas)
    .filter((a) => a.level === level && world.x >= a.origin.x && world.x < a.origin.x + a.w && world.y >= a.origin.y && world.y < a.origin.y + a.h)
    .sort((a, b) => a.w * a.h - b.w * b.h || compareIds(a.id, b.id));
  return hits[0]?.id ?? null;
}
