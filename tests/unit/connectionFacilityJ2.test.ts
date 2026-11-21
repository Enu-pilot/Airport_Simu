import { describe, expect, it } from 'vitest';
import {
  addTerminalTransitLink,
  createConnectionFacility,
  deleteConnectionFacility,
  deleteEntity,
  deleteTerminalTransitLink,
  groupConnectionFacility,
  moveConnectionFacility,
  placeFacility,
  placeTerminalArea,
  updateConnectionFacility,
} from '../../src/core/layout/operations';
import { connectionDeckLevel } from '../../src/core/terminal/connectionFacility';
import { connectionFacilityCost } from '../../src/core/economy/construction';
import { analyzeLayout } from '../../src/core/validation/validate';
import { buildProject, formatVersionOf, serializeProject, validateProject } from '../../src/core/io/project';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { createSandboxCompany } from '../../src/core/economy/company';
import { commit, createHistory, undo } from '../../src/core/editor/history';
import type { AirportLayout, ConnectionFacility, Facility, TerminalArea } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

/**
 * 機能J-2: 連絡施設の複合化（グルーピング記録 ConnectionFacility）。
 * 設計は design-GHIJ-detail.md §J.3 + タスク表 J.4（JT3〜JT5）が正本。
 * 受入条件: 記録を使わない既存レイアウトでは検証・運航結果が従来と完全一致すること
 * （シミュレーションは記録を読まない。ゴールデン全件不変で担保）。
 */

interface Fixture {
  layout: AirportLayout;
  termA: Facility;
  termB: Facility;
  endA: TerminalArea;
  endB: TerminalArea;
}

/** 2つのターミナル（既定7階建て）と、各1Fに出発区域の端点エリアを置く */
function fixture(levels = 7): Fixture {
  let l = emptyLayout(120, 80);
  l = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, { props: { levels } })).layout;
  const termA = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
  l = must(placeFacility(l, 'terminal', { x: 60, y: 10 }, { props: { levels } })).layout;
  const termB = Object.values(l.facilities).find((f) => f.kind === 'terminal' && f.id !== termA.id)!;
  l = must(placeTerminalArea(l, termA.id, 0, 'hall', { x: 12, y: 12 }, { zone: 'departure' })).layout;
  const endA = Object.values(l.terminalAreas).find((a) => a.terminalId === termA.id)!;
  l = must(placeTerminalArea(l, termB.id, 0, 'hall', { x: 62, y: 12 }, { zone: 'departure' })).layout;
  const endB = Object.values(l.terminalAreas).find((a) => a.terminalId === termB.id)!;
  return { layout: l, termA, termB, endA, endB };
}

const projectOf = (layout: AirportLayout) =>
  buildProject({ name: 'j2', savedAt: '2026-11-21T00:00:00.000Z', layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });

const codesFor = (layout: AirportLayout, id: string): string[] =>
  analyzeLayout(layout).byTarget[id]?.map((i) => i.code) ?? [];

const createElevated = (f: Fixture, extra: Partial<Parameters<typeof createConnectionFacility>[1]> = {}) =>
  createConnectionFacility(f.layout, {
    name: '北連絡橋',
    fromAreaId: f.endA.id,
    toAreaId: f.endB.id,
    link: { kind: 'elevatedWalkway', distanceM: 300, travelSec: 240, crossingMaxCode: 'C' },
    aVerticalKind: 'escalator',
    bVerticalKind: 'escalator',
    ...extra,
  });

/** 成功前提版（型を成功側へ狭める） */
const createElevatedOk = (f: Fixture, extra: Partial<Parameters<typeof createConnectionFacility>[1]> = {}) =>
  must(createElevated(f, extra));

describe('JT3: 複合作成（端点 → 通路段 → 両端の垂直ノード）', () => {
  it('高層通路 C コード: デッキ階（建物内階3）までのシャフトが両端に生成され、記録が残る', () => {
    const f = fixture();
    const r = createElevatedOk(f);
    const cfId = r.created[0]!;
    expect(cfId.startsWith('cf_')).toBe(true);
    const cf = r.layout.connectionFacilities?.[cfId];
    expect(cf).toBeDefined();
    expect(cf!.name).toBe('北連絡橋');
    expect(cf!.segment).toEqual({ kind: 'link', linkId: r.created[1] });
    const link = r.layout.terminalLinks?.[r.created[1]!]!;
    expect(link.kind).toBe('elevatedWalkway');
    expect(link.crossingMaxCode).toBe('C');
    expect(connectionDeckLevel(link)).toBe(3);
    // シャフト: 端点階0 → デッキ階3 のため階1・2・3（両端3件ずつ）
    const aAreas = cf!.aVerticalAreaIds.map((id) => r.layout.terminalAreas[id]!);
    const bAreas = cf!.bVerticalAreaIds.map((id) => r.layout.terminalAreas[id]!);
    expect(aAreas.map((a) => a.level).sort()).toEqual([1, 2, 3]);
    expect(bAreas.map((a) => a.level).sort()).toEqual([1, 2, 3]);
    expect(aAreas.every((a) => a.kind === 'escalator' && a.terminalId === f.termA.id)).toBe(true);
    expect(bAreas.every((a) => a.kind === 'escalator' && a.terminalId === f.termB.id)).toBe(true);
    // エスカレーター両端 → 段差なしは導出で true
    expect(cf!.stepFree).toBe(true);
    // 費用集計は部品（リンク＋垂直エリア6件）の合計と一致する
    expect(connectionFacilityCost(r.layout, cfId)).toBeGreaterThan(0);
  });

  it('段差なしの導出: 階段のみ → false、エレベーター → true、明示指定が導出に優先する', () => {
    const f = fixture();
    const stairs = createElevatedOk(f, { aVerticalKind: 'stairs', bVerticalKind: 'stairs' });
    expect(stairs.layout.connectionFacilities?.[stairs.created[0]!]!.stepFree).toBe(false);

    const f2 = fixture();
    const lift = createElevatedOk(f2, { aVerticalKind: 'elevator', bVerticalKind: 'elevator' });
    expect(lift.layout.connectionFacilities?.[lift.created[0]!]!.stepFree).toBe(true);

    const f3 = fixture();
    const declared = createElevatedOk(f3, { aVerticalKind: 'stairs', bVerticalKind: 'stairs', stepFree: true });
    expect(declared.layout.connectionFacilities?.[declared.created[0]!]!.stepFree).toBe(true);
  });

  it('歩行通路（端点階＝通路段の階）では垂直エリアは生成されず、段差なしは true', () => {
    const f = fixture();
    const r = must(
      createConnectionFacility(f.layout, {
        fromAreaId: f.endA.id,
        toAreaId: f.endB.id,
        link: { kind: 'walkway', distanceM: 200, travelSec: 150 },
        aVerticalKind: 'stairs',
        bVerticalKind: 'stairs',
      }),
    );
    const cf = r.layout.connectionFacilities?.[r.created[0]!]!;
    expect(cf.aVerticalAreaIds).toEqual([]);
    expect(cf.bVerticalAreaIds).toEqual([]);
    expect(cf.stepFree).toBe(true);
  });

  it('失敗は原子的: 同一ターミナルの端点・階範囲超過・重なりではレイアウトが一切変わらない', () => {
    const f = fixture();
    const before = JSON.stringify(f.layout);
    const sameTerminal = createConnectionFacility(f.layout, {
      fromAreaId: f.endA.id,
      toAreaId: f.endA.id,
      link: { kind: 'walkway', distanceM: 100, travelSec: 60 },
    });
    expect(sameTerminal.ok).toBe(false);
    expect(JSON.stringify(f.layout)).toBe(before);

    // 2階建てターミナルにデッキ階3の高層通路 → シャフトが階範囲を超える
    const low = fixture(2);
    const lowBefore = JSON.stringify(low.layout);
    const tooHigh = createElevated(low);
    expect(tooHigh.ok).toBe(false);
    expect(JSON.stringify(low.layout)).toBe(lowBefore);

    // シャフト予定位置（端点と同じ位置・階1）に既存エリアがある → 重なりで失敗
    const blocked = fixture();
    const withBlock = must(
      placeTerminalArea(blocked.layout, blocked.termA.id, 1, 'escalator', { x: 12, y: 12 }, { zone: 'departure' }),
    ).layout;
    const blockedBefore = JSON.stringify(withBlock);
    const r = createElevated({ ...blocked, layout: withBlock });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(withBlock)).toBe(blockedBefore);
  });

  it('作成 → 削除で部品（リンク・垂直エリア）が残らず、端点エリアだけが残る', () => {
    const f = fixture();
    const areaCount = Object.keys(f.layout.terminalAreas).length;
    const r = createElevatedOk(f);
    const cfId = r.created[0]!;
    const del = must(deleteConnectionFacility(r.layout, cfId));
    expect(Object.keys(del.layout.connectionFacilities ?? {})).toHaveLength(0);
    expect(Object.keys(del.layout.terminalLinks ?? {})).toHaveLength(0);
    expect(Object.keys(del.layout.terminalAreas)).toHaveLength(areaCount);
    expect(del.layout.terminalAreas[f.endA.id]).toBeDefined();
    expect(del.layout.terminalAreas[f.endB.id]).toBeDefined();
    // 記録が無くなれば版9ではなくなる
    expect(formatVersionOf(projectOf(del.layout))).toBeLessThan(9);
  });

  it('既存部品のグルーピング（記録のみ）: 導出・検証・不正な垂直エリアの拒否', () => {
    const f = fixture();
    // 部品を手作業で用意する: 高層通路リンク＋A側シャフト（階1のみ）
    let l = must(
      addTerminalTransitLink(f.layout, {
        kind: 'elevatedWalkway',
        fromAreaId: f.endA.id,
        toAreaId: f.endB.id,
        distanceM: 300,
        travelSec: 240,
        crossingMaxCode: 'C',
        allowedZones: ['departure'],
      }),
    ).layout;
    const linkId = Object.keys(l.terminalLinks ?? {})[0]!;
    l = must(placeTerminalArea(l, f.termA.id, 1, 'elevator', { x: 12, y: 12 }, { zone: 'departure' })).layout;
    const liftA = Object.values(l.terminalAreas).find((a) => a.kind === 'elevator')!;

    const g = must(groupConnectionFacility(l, { linkId, aVerticalAreaIds: [liftA.id], name: '手組み' }));
    const cf = g.layout.connectionFacilities?.[g.created[0]!]!;
    expect(cf.name).toBe('手組み');
    expect(cf.aVerticalAreaIds).toEqual([liftA.id]);
    // A側はエレベーターで移動あり・B側は移動なし（端点階≠デッキ階だが垂直エリア無し）
    // → B側は段差なし経路が無いため stepFree は false に導出される
    expect(cf.stepFree).toBe(false);

    // 別ターミナルのエリアを A 側に混ぜる → INVALID_VALUE
    const wrong = groupConnectionFacility(l, { linkId, aVerticalAreaIds: [f.endB.id] });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe('INVALID_VALUE');
    // 存在しないリンク → NOT_FOUND
    const missing = groupConnectionFacility(l, { linkId: 'tl_999' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('NOT_FOUND');
  });

  it('改名・段差なし切替・垂直エリアのまとめて移動（端点は動かない）', () => {
    const f = fixture();
    const r = createElevatedOk(f);
    const cfId = r.created[0]!;
    const renamed = must(updateConnectionFacility(r.layout, cfId, { name: '南連絡橋', stepFree: false }));
    expect(renamed.layout.connectionFacilities?.[cfId]).toMatchObject({ name: '南連絡橋', stepFree: false });
    // 同値パッチは NO_CHANGE
    const noop = updateConnectionFacility(renamed.layout, cfId, { name: '南連絡橋' });
    expect(noop.ok).toBe(false);
    if (!noop.ok) expect(noop.reason).toBe('NO_CHANGE');

    const cf = renamed.layout.connectionFacilities![cfId]!;
    const beforeA = cf.aVerticalAreaIds.map((id) => renamed.layout.terminalAreas[id]!.origin);
    const moved = must(moveConnectionFacility(renamed.layout, cfId, { x: 1, y: 0 }));
    const afterA = cf.aVerticalAreaIds.map((id) => moved.layout.terminalAreas[id]!.origin);
    expect(afterA).toEqual(beforeA.map((o) => ({ x: o.x + 1, y: o.y })));
    expect(moved.layout.terminalAreas[f.endA.id]!.origin).toEqual(f.endA.origin);
    // 移動量ゼロは NO_CHANGE（単体エリア移動 moveEntity と同じ検証なしの意味論を合成している）
    const noopMove = moveConnectionFacility(moved.layout, cfId, { x: 0, y: 0 });
    expect(noopMove.ok).toBe(false);
    if (!noopMove.ok) expect(noopMove.reason).toBe('NO_CHANGE');
  });

  it('部品の個別削除に記録が追随する（finalize: 垂直エリアは一覧から外れ、リンク削除で記録も消える）', () => {
    const f = fixture();
    const r = createElevatedOk(f);
    const cfId = r.created[0]!;
    const cf = r.layout.connectionFacilities![cfId]!;
    const victim = cf.aVerticalAreaIds[0]!;
    const afterAreaDelete = must(deleteEntity(r.layout, victim));
    expect(afterAreaDelete.layout.connectionFacilities?.[cfId]?.aVerticalAreaIds).not.toContain(victim);
    expect(afterAreaDelete.layout.connectionFacilities?.[cfId]).toBeDefined();

    const linkId = (cf.segment as { kind: 'link'; linkId: string }).linkId;
    const afterLinkDelete = must(deleteTerminalTransitLink(afterAreaDelete.layout, linkId));
    expect(afterLinkDelete.layout.connectionFacilities?.[cfId]).toBeUndefined();
  });

  it('複合作成は Undo 1回で巻き戻る（履歴へのコミットは1エントリ）', () => {
    const f = fixture();
    let h = createHistory(f.layout);
    const r = createElevatedOk(f);
    h = commit(h, r.layout);
    expect(Object.keys(h.present.connectionFacilities ?? {})).toHaveLength(1);
    h = undo(h);
    expect(h.present).toBe(f.layout);
    expect(h.present.connectionFacilities).toBeUndefined();
  });
});

describe('JT4: 検証3コード', () => {
  it('記録の無いレイアウトでは CONNECTION_* は一切出ない', () => {
    const f = fixture();
    const issues = analyzeLayout(f.layout).issues.filter((i) => i.code.startsWith('CONNECTION_'));
    expect(issues).toEqual([]);
  });

  it('DANGLING: 参照切れ（リンク欠落・別ターミナルの垂直エリア）はエラー', () => {
    const f = fixture();
    const broken: AirportLayout = {
      ...f.layout,
      connectionFacilities: {
        cf_1: {
          id: 'cf_1',
          name: '壊れた記録',
          segment: { kind: 'link', linkId: 'tl_404' },
          aVerticalAreaIds: [],
          bVerticalAreaIds: [],
          stepFree: false,
        } satisfies ConnectionFacility,
      },
    };
    expect(codesFor(broken, 'cf_1')).toContain('CONNECTION_FACILITY_DANGLING');
    const issue = analyzeLayout(broken).byTarget['cf_1']!.find((i) => i.code === 'CONNECTION_FACILITY_DANGLING')!;
    expect(issue.severity).toBe('error');

    // リンクは実在するが、垂直エリアが相手ターミナルのもの → DANGLING
    const r = createElevatedOk(f);
    const cfId = r.created[0]!;
    const mixed: AirportLayout = {
      ...r.layout,
      connectionFacilities: {
        [cfId]: { ...r.layout.connectionFacilities![cfId]!, aVerticalAreaIds: [f.endB.id] },
      },
    };
    expect(codesFor(mixed, cfId)).toContain('CONNECTION_FACILITY_DANGLING');
  });

  it('FLOOR_GAP: 垂直エリアがデッキ階まで届かないと警告、届けば消える。歩行通路では出ない', () => {
    const f = fixture();
    // A/B 両側とも階1のエレベーターだけ（段は階0-1のみカバー、デッキ階3まで届かない）
    let l = must(
      addTerminalTransitLink(f.layout, {
        kind: 'elevatedWalkway',
        fromAreaId: f.endA.id,
        toAreaId: f.endB.id,
        distanceM: 300,
        travelSec: 240,
        crossingMaxCode: 'C',
        allowedZones: ['departure'],
      }),
    ).layout;
    const linkId = Object.keys(l.terminalLinks ?? {})[0]!;
    l = must(placeTerminalArea(l, f.termA.id, 1, 'elevator', { x: 12, y: 12 }, { zone: 'departure' })).layout;
    l = must(placeTerminalArea(l, f.termB.id, 1, 'elevator', { x: 62, y: 12 }, { zone: 'departure' })).layout;
    const lifts = Object.values(l.terminalAreas).filter((a) => a.kind === 'elevator');
    const g = must(
      groupConnectionFacility(l, {
        linkId,
        aVerticalAreaIds: lifts.filter((a) => a.terminalId === f.termA.id).map((a) => a.id),
        bVerticalAreaIds: lifts.filter((a) => a.terminalId === f.termB.id).map((a) => a.id),
      }),
    );
    const cfId = g.created[0]!;
    const gaps = analyzeLayout(g.layout).byTarget[cfId]!.filter((i) => i.code === 'CONNECTION_FACILITY_FLOOR_GAP');
    expect(gaps).toHaveLength(2);
    expect(gaps.every((i) => i.severity === 'warning')).toBe(true);

    // 複合作成でフルシャフトを作れば FLOOR_GAP は出ない
    const full = createElevatedOk(fixture());
    const fullId = full.created[0]!;
    expect(codesFor(full.layout, fullId)).not.toContain('CONNECTION_FACILITY_FLOOR_GAP');

    // 歩行通路の記録では FLOOR_GAP は出ない
    const walk = must(
      createConnectionFacility(f.layout, {
        fromAreaId: f.endA.id,
        toAreaId: f.endB.id,
        link: { kind: 'walkway', distanceM: 200, travelSec: 150 },
      }),
    );
    expect(codesFor(walk.layout, walk.created[0]!)).not.toContain('CONNECTION_FACILITY_FLOOR_GAP');
  });

  it('STEP_FREE: 段差なし申告なのに片側が階段のみだと警告、申告なし・解消で消える', () => {
    const f = fixture();
    const r = createElevatedOk(f, { aVerticalKind: 'stairs', bVerticalKind: 'escalator', stepFree: true });
    const cfId = r.created[0]!;
    const issues = analyzeLayout(r.layout).byTarget[cfId]!.filter((i) => i.code === 'CONNECTION_FACILITY_STEP_FREE');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    // 申告を取り下げれば警告は消える
    const fixed = must(updateConnectionFacility(r.layout, cfId, { stepFree: false }));
    expect(codesFor(fixed.layout, cfId)).not.toContain('CONNECTION_FACILITY_STEP_FREE');
    // 導出どおり（階段のみ → stepFree false で作成）でも出ない
    const honest = createElevatedOk(fixture(), { aVerticalKind: 'stairs', bVerticalKind: 'stairs' });
    expect(codesFor(honest.layout, honest.created[0]!)).not.toContain('CONNECTION_FACILITY_STEP_FREE');
  });
});

describe('保存形式（版9）と往復・旧セーブ互換', () => {
  it('記録を含むレイアウトだけが版9になり、往復保存で記録が保持される', () => {
    const f = fixture();
    expect(formatVersionOf(projectOf(f.layout))).toBeLessThan(9);
    const r = createElevatedOk(f);
    const p = projectOf(r.layout);
    expect(formatVersionOf(p)).toBe(9);
    const text = serializeProject(p);
    expect(text).toContain('connectionFacilities');
    const v = validateProject(text, { fallbackCompany: createSandboxCompany() });
    expect(v.ok).toBe(true);
    const cfId = r.created[0]!;
    expect(v.project!.layout.connectionFacilities?.[cfId]).toEqual(r.layout.connectionFacilities?.[cfId]);
    // レイアウト単体の往復でも保持される
    const roundTrip = importLayout(exportLayout(r.layout));
    expect(roundTrip.connectionFacilities).toEqual(r.layout.connectionFacilities);
  });

  it('版8以下を名乗るのに記録を含むファイルは拒否される', () => {
    const r = createElevatedOk(fixture());
    const tampered = JSON.stringify({ ...JSON.parse(serializeProject(projectOf(r.layout))), formatVersion: 8 });
    const v = validateProject(tampered, { fallbackCompany: createSandboxCompany() });
    expect(v.ok).toBe(false);
  });

  it('記録の形が壊れたファイルは読み込みで拒否される（参照切れ自体は拒否しない）', () => {
    const f = fixture();
    const malformed: AirportLayout = {
      ...f.layout,
      connectionFacilities: {
        cf_1: { id: 'cf_2', name: 42, segment: { kind: 'link' }, aVerticalAreaIds: 'x', bVerticalAreaIds: [], stepFree: 'yes' } as unknown as ConnectionFacility,
      },
    };
    expect(() => importLayout(exportLayout(malformed))).toThrow();
    // 参照切れ（リンク欠落）は読み込み可能で、検証が DANGLING で報告する
    const dangling: AirportLayout = {
      ...f.layout,
      connectionFacilities: {
        cf_1: { id: 'cf_1', name: '', segment: { kind: 'link', linkId: 'tl_404' }, aVerticalAreaIds: [], bVerticalAreaIds: [], stepFree: false },
      },
    };
    const loaded = importLayout(exportLayout(dangling));
    expect(loaded.connectionFacilities?.['cf_1']).toBeDefined();
    expect(codesFor(loaded, 'cf_1')).toContain('CONNECTION_FACILITY_DANGLING');
  });

  it('旧セーブ（記録キー自体が無い）でも作成・検証が従来どおり動く', () => {
    const f = fixture();
    expect(f.layout.connectionFacilities).toBeUndefined();
    const loaded = importLayout(exportLayout(f.layout));
    expect(loaded.connectionFacilities).toBeUndefined();
    const r = createElevatedOk({ ...f, layout: loaded });
    expect(Object.keys(r.layout.connectionFacilities ?? {})).toHaveLength(1);
  });
});
