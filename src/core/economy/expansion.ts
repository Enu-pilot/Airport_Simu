import { sortedValues } from '../model/ids';
import { entityTypeOf, isFreeRunway, type AirportLayout, type BuildState, type FacilityKind } from '../model/types';
import { cloneLayout } from '../layout/operations';
import type { CompanyState, Project } from './company';

/**
 * 空港の拡張計画と工事（docs/15_access_rules.md §6）。キャリアモードのみ。
 *
 * - 新しく建設した施設・滑走路などはすぐには使えず、「建設中」で工期（日数）を待つ。
 * - 運用中の施設を移設・延長・拡幅（形状の変更）すると「改修工事」となり、工期のあいだ閉鎖される。
 * - プレイヤーは運用中の施設を一時閉鎖できる（工期を指定、費用なし）。
 * - 工期は運航した日（日次締め）ごとに 1 日進む。完成は運航を終えたときにレイアウトへ反映し、次の運航から使える。
 * サンドボックスでは工期はなく、すぐに完成する（従来どおり）。
 */

export const BUILD_DAYS = {
  runway: 6,
  taxiway: 1,
  road: 1,
  stand: 2,
  facility: 2,
} as const;

const FACILITY_DAYS: Partial<Record<FacilityKind, number>> = {
  terminal: 5,
  hangar: 4,
  tower: 3,
  maintenance: 3,
  fuelFarm: 3,
  fireStation: 3,
  gseBase: 2,
  baggageSort: 3,
  gate: 1,
  apron: 2,
  serviceArea: 1,
  parking: 1,
  staffParking: 1,
  taxiStand: 1,
  busStop: 1,
  railStation: 5,
  hotel: 4,
};

/** 建設状態を持つエンティティ（ノード・ターミナル内部のエリアは対象外） */
type Buildable = { buildState: BuildState };

function entityOf(layout: AirportLayout, id: string): Buildable | undefined {
  return layout.runways[id] ?? layout.taxiways[id] ?? layout.roads[id] ?? layout.stands[id] ?? layout.facilities[id];
}

export function buildDays(layout: AirportLayout, id: string): number {
  const f = layout.facilities[id];
  if (f) return FACILITY_DAYS[f.kind] ?? BUILD_DAYS.facility;
  const t = entityTypeOf(id);
  return t === 'runway' ? BUILD_DAYS.runway : t === 'taxiway' ? BUILD_DAYS.taxiway : t === 'road' ? BUILD_DAYS.road : t === 'stand' ? BUILD_DAYS.stand : 1;
}

/** 形状（位置・寸法・向き・階数）。変わると改修工事になる */
function geometry(layout: AirportLayout, id: string): string {
  const r = layout.runways[id];
  if (r) {
    if (isFreeRunway(r)) return JSON.stringify(['free', r.start, r.headingDeg, r.lengthM, r.surfaceWidthM, r.dims?.shoulderWidthM ?? null]);
    return JSON.stringify([r.start, r.heading, r.length, r.surfaceWidthM]);
  }
  const tw = layout.taxiways[id];
  if (tw) return JSON.stringify([layout.taxiNodes[tw.from]?.pos, layout.taxiNodes[tw.to]?.pos, tw.widthClass]);
  const rd = layout.roads[id];
  if (rd) return JSON.stringify([layout.roadNodes[rd.from]?.pos, layout.roadNodes[rd.to]?.pos, rd.roadClass]);
  const s = layout.stands[id];
  if (s) return JSON.stringify([s.origin, s.size, s.rotation]);
  const f = layout.facilities[id];
  if (f) return JSON.stringify([f.origin, f.w, f.h, f.rotation, f.kind === 'terminal' ? f.props.levels : 0]);
  return '';
}

function allIds(layout: AirportLayout): string[] {
  return [
    ...Object.keys(layout.runways),
    ...Object.keys(layout.taxiways),
    ...Object.keys(layout.roads),
    ...Object.keys(layout.stands),
    ...Object.keys(layout.facilities),
  ];
}

/**
 * キャリアモードの編集を工事に変える: 新設・建設中へ変更した施設、形状を変えた運用中の施設を「建設中」にし、工事を登録する。
 * 工事中の施設を「運用中」にしようとしても、工期が終わるまでは建設中のまま。
 */
export function prepareCareerEdit(c: CompanyState, before: AirportLayout, after: AirportLayout): AirportLayout {
  if (c.mode !== 'career') return after;
  const d = cloneLayout(after);
  for (const id of allIds(d)) {
    const e = entityOf(d, id)!;
    if (e.buildState === 'planned') continue;
    const prev = entityOf(before, id);
    const project = c.projects[id];
    if (project && project.remaining > 0) {
      e.buildState = 'underConstruction';
      continue;
    }
    if (!prev || prev.buildState !== 'operational') {
      // 新設、または計画・建設中からの変更
      if (e.buildState === 'operational' || !project) e.buildState = 'underConstruction';
    } else if (e.buildState === 'operational' && geometry(before, id) !== geometry(d, id)) {
      e.buildState = 'underConstruction';
      c.projects[id] = newProject(c, d, id, 'renovation');
    }
  }
  syncProjects(c, d);
  return d;
}

function newProject(c: CompanyState, layout: AirportLayout, id: string, kind: Project['kind'], days = buildDays(layout, id)): Project {
  return { id, kind, startDay: c.day, days, remaining: days };
}

/**
 * レイアウトと工事の一覧を合わせる（元に戻す・やり直しの後にも呼ぶ）:
 * 建設中なのに工事がないものは新設工事を登録し、建設中でなくなったもの・削除されたものの工事は取り消す。
 */
export function syncProjects(c: CompanyState, layout: AirportLayout): void {
  if (c.mode !== 'career') return;
  for (const id of allIds(layout)) {
    const e = entityOf(layout, id)!;
    if (e.buildState === 'underConstruction' && !c.projects[id]) c.projects[id] = newProject(c, layout, id, 'build');
  }
  for (const id of Object.keys(c.projects)) {
    const e = entityOf(layout, id);
    if (!e || e.buildState !== 'underConstruction') delete c.projects[id];
  }
}

/** 運用中の施設を一時閉鎖する（days 日、費用なし） */
export function startClosure(c: CompanyState, layout: AirportLayout, id: string, days: number): AirportLayout | null {
  const e = entityOf(layout, id);
  if (!e || e.buildState !== 'operational' || days < 1) return null;
  const d = cloneLayout(layout);
  entityOf(d, id)!.buildState = 'underConstruction';
  c.projects[id] = newProject(c, d, id, 'closure', Math.round(days));
  return d;
}

/** 日次締め: 工事を1日進める。完成したものの通知を返す */
export function advanceProjects(c: CompanyState): string[] {
  const out: string[] = [];
  for (const p of sortedValues(c.projects)) {
    if (p.remaining <= 0) continue;
    p.remaining--;
    if (p.remaining === 0) out.push(`${PROJECT_KIND_TEXT[p.kind]}が完了しました（${p.id}）。次の運航から使えます`);
  }
  return out;
}

const PROJECT_KIND_TEXT: Record<Project['kind'], string> = { build: '建設工事', renovation: '改修工事', closure: '一時閉鎖' };

/** 完了した工事をレイアウトに反映する（運用中にして工事を消す）。変化がなければ null */
export function applyCompletedProjects(c: CompanyState, layout: AirportLayout): AirportLayout | null {
  const done = Object.values(c.projects).filter((p) => p.remaining <= 0);
  if (done.length === 0) return null;
  const d = cloneLayout(layout);
  for (const p of done) {
    const e = entityOf(d, p.id);
    if (e) e.buildState = 'operational';
    delete c.projects[p.id];
  }
  return d;
}
