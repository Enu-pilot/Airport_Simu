/**
 * 監査 docs/38 ID 04（階層・建物内部設備, docs/34）— 地下/地上/高架/建物内部の重複配置・衝突・接続・移動・保存。
 * 既存: tests/unit/verticalTransport.test.ts, validation.test.ts, terminalTransit.test.ts。
 * 追加: 同一階/異階の重複配置の衝突規則、建物内部設備の親子規則（移動・削除・複製）、道路階層コネクタの検証コード、
 *       コネクタ切断/再接続での歩行経路、ランダム多層配置の保存往復と検証の決定性。
 */
import { describe, expect, it } from 'vitest';
import { findPedestrianRoute } from '../../src/core/access/verticalWalk';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import {
  addRoadPath,
  connectRoadLevels,
  deleteEntity,
  duplicateEntity,
  moveEntity,
  placeFacility,
  updateEntity,
} from '../../src/core/layout/operations';
import { facilityVerticalRange, MAX_MAP_LEVEL, MIN_MAP_LEVEL } from '../../src/core/model/levels';
import type { AirportLayout, FacilityKind } from '../../src/core/model/types';
import { Rng } from '../../src/core/rng';
import { analyzeLayout, type Issue } from '../../src/core/validation/validate';
import { emptyLayout, must } from '../unit/helpers';

const issuesFor = (l: AirportLayout, code: string, ...ids: string[]): Issue[] =>
  analyzeLayout(l).issues.filter((i) => i.code === code && ids.every((id) => i.targets.includes(id)));

describe('ID04 同一平面位置の重複配置: 階が違えば許され、同じ階/高さが交差すれば衝突', () => {
  const base = () => emptyLayout(60, 60);
  const put = (l: AirportLayout, kind: FacilityKind, level: number, x = 10, y = 10) => {
    const r = must(placeFacility(l, kind, { x, y }, { mapLevel: level }));
    return { layout: r.layout, id: r.created[0]! };
  };

  it('同じ階（地上）に同じ位置へ 2 つ → OVERLAP（error）', () => {
    let l = base();
    const a = put(l, 'parking', 0);
    l = a.layout;
    const b = put(l, 'parking', 0);
    l = b.layout;
    expect(issuesFor(l, 'OVERLAP', a.id, b.id)).toHaveLength(1);
    expect(issuesFor(l, 'OVERLAP', a.id, b.id)[0]!.severity).toBe('error');
  });

  for (const lv of [-3, -2, -1, 1, 2, 5]) {
    it(`地上の駐車場と mapLevel=${lv} の駐車場を同じ位置に置いても重複扱いにならない（高さ区間が交差しない）`, () => {
      let l = base();
      const a = put(l, 'parking', 0);
      l = a.layout;
      const b = put(l, 'parking', lv);
      l = b.layout;
      expect(issuesFor(l, 'OVERLAP', a.id, b.id)).toHaveLength(0);
      // 同じ階に重ねれば衝突する（階が違うことだけが理由で通る）
      const c = put(l, 'parking', lv);
      expect(issuesFor(c.layout, 'OVERLAP', b.id, c.id)).toHaveLength(1);
    });
  }

  it('高さが階をまたぐ建物（3 階建てターミナル ≒ 32 m）の上に重ねた mapLevel=1,2 の施設は衝突（実際に高さが交差）', () => {
    let l = base();
    const t = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, { w: 6, h: 6, props: { levels: 3 } }));
    l = t.layout;
    const range = facilityVerticalRange(l.facilities[t.created[0]!]!);
    expect(range.maxM).toBeGreaterThan(12);
    const p = put(l, 'parking', 1, 11, 11);
    expect(issuesFor(p.layout, 'OVERLAP', t.created[0]!, p.id).length).toBeGreaterThanOrEqual(1);
    // 十分に高い階 (level 6 = 36m) は交差しない
    const q = put(l, 'parking', 6, 11, 11);
    expect(issuesFor(q.layout, 'OVERLAP', t.created[0]!, q.id)).toHaveLength(0);
  });

  it('階層の範囲外（< -5, > 10）や非整数は INVALID_VALUE で拒否され、レイアウトは変化しない', () => {
    const l = base();
    for (const bad of [MIN_MAP_LEVEL - 1, MAX_MAP_LEVEL + 1, 1.5, Number.NaN]) {
      expect(placeFacility(l, 'parking', { x: 5, y: 5 }, { mapLevel: bad })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    }
    for (const good of [MIN_MAP_LEVEL, MAX_MAP_LEVEL]) expect(placeFacility(l, 'parking', { x: 5, y: 5 }, { mapLevel: good }).ok).toBe(true);
  });
});

describe('ID04 建物内部設備（parentFacilityId / floorIndex）', () => {
  function building(levels = 3) {
    let l = emptyLayout(60, 60);
    const t = must(placeFacility(l, 'terminal', { x: 10, y: 10 }, { w: 10, h: 8, props: { levels } }));
    l = t.layout;
    return { l, tid: t.created[0]! };
  }
  const child = (l: AirportLayout, tid: string, floor: number, x = 12, y = 12, kind: FacilityKind = 'gseBase') =>
    placeFacility(l, kind, { x, y }, { parentFacilityId: tid, floorIndex: floor });

  it('異なる内部階の同一平面位置は共存でき、同じ階の同じ位置は衝突する', () => {
    const b0 = building(3);
    const tid = b0.tid;
    let l = b0.l;
    const ids: string[] = [];
    for (const f of [0, 1, 2]) {
      const r = must(child(l, tid, f));
      l = r.layout;
      ids.push(r.created[0]!);
    }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(issuesFor(l, 'OVERLAP', ids[i]!, ids[j]!)).toHaveLength(0);
    const dup = must(child(l, tid, 1));
    expect(issuesFor(dup.layout, 'OVERLAP', ids[1]!, dup.created[0]!)).toHaveLength(1);
  });

  it('床番号が建物の階数以上、または親が建物でない/入れ子/はみ出しの内部設備は拒否される', () => {
    const { l, tid } = building(2);
    expect(child(l, tid, 2)).toEqual({ ok: false, reason: 'INVALID_VALUE' }); // levels=2 → floorIndex 0..1
    expect(child(l, tid, -6)).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(child(l, tid, 0.5)).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(child(l, tid, 0, 40, 40)).toEqual({ ok: false, reason: 'INVALID_VALUE' }); // 親の外
    expect(placeFacility(l, 'gseBase', { x: 12, y: 12 }, { parentFacilityId: 'fac_999', floorIndex: 0 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    const c = must(child(l, tid, 0));
    // 子の下にさらに子 → 不可
    expect(placeFacility(c.layout, 'parking', { x: 12, y: 12 }, { parentFacilityId: c.created[0]!, floorIndex: 0 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    // 親なしで floorIndex だけ → 不可
    expect(placeFacility(l, 'parking', { x: 30, y: 30 }, { floorIndex: 0 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });

  it('親の移動で子と内部エリアが一緒に動き、親の削除で子も消え、複製後も ID は一意', () => {
    const b1 = building(2);
    const tid = b1.tid;
    let l = b1.l;
    const c = must(child(l, tid, 1));
    l = c.layout;
    const cid = c.created[0]!;
    const before = { ...l.facilities[cid]!.origin };
    const moved = must(moveEntity(l, tid, { x: 5, y: 3 }));
    expect(moved.layout.facilities[cid]!.origin).toEqual({ x: before.x + 5, y: before.y + 3 });
    expect(moved.layout.facilities[cid]!.parentFacilityId).toBe(tid);
    expect(moved.layout.facilities[cid]!.floorIndex).toBe(1);
    const dup = must(duplicateEntity(moved.layout, tid));
    const allIds = Object.keys(dup.layout.facilities);
    expect(new Set(allIds).size).toBe(allIds.length);
    const del = must(deleteEntity(moved.layout, tid));
    expect(del.layout.facilities[cid]).toBeUndefined();
    expect(Object.keys(del.layout.facilities)).toHaveLength(0);
  });

  it('[観測] 内部設備を持つ建物を複製しても内部設備は複製されない（子は元の親に残る）— 仕様記述なし (E)', () => {
    const { l, tid } = building(2);
    const c = must(child(l, tid, 0));
    const dup = must(duplicateEntity(c.layout, tid));
    const newTid = dup.created[0]!;
    const kids = Object.values(dup.layout.facilities).filter((f) => f.parentFacilityId === newTid);
    expect(kids).toHaveLength(0);
    expect(Object.values(dup.layout.facilities).filter((f) => f.parentFacilityId === tid)).toHaveLength(1);
  });

  it('建物の階数/外形を内部設備が収まらない値へ変える更新は INVALID_VALUE で拒否され、レイアウトは変わらない', () => {
    const { l, tid } = building(3);
    const c = must(child(l, tid, 2));
    expect(updateEntity(c.layout, tid, { props: { levels: 1 } })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    expect(updateEntity(c.layout, tid, { w: 3, h: 3 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });
});

describe('ID04 道路階層コネクタ・歩行経路: 切断と再接続', () => {
  const nodeAt = (l: AirportLayout, level: number, x: number, y: number) => Object.values(l.roadNodes).find((n) => (n.level ?? 0) === level && n.pos.x === x && n.pos.y === y)!.id;

  function twoLevels(): AirportLayout {
    let l = emptyLayout(60, 40);
    l = must(addRoadPath(l, [{ x: 10, y: 10 }, { x: 30, y: 10 }], { roadClass: 'walkway', level: 0, capacityPerHour: 600 })).layout;
    l = must(addRoadPath(l, [{ x: 10, y: 10 }, { x: 30, y: 10 }], { roadClass: 'walkway', level: -1, capacityPerHour: 600 })).layout;
    l = must(addRoadPath(l, [{ x: 10, y: 10 }, { x: 30, y: 10 }], { roadClass: 'walkway', level: 2, capacityPerHour: 600 })).layout;
    return l;
  }
  const fac = (l: AirportLayout, kind: FacilityKind, level: number, x: number, y: number) => {
    const r = must(placeFacility(l, kind, { x, y }, { mapLevel: level }));
    return { l: r.layout, id: r.created[0]! };
  };

  it('各階は同じ平面座標でも別ノード。垂直コネクタがなければ階をまたぐ歩行経路はない', () => {
    const l = twoLevels();
    expect(new Set([nodeAt(l, 0, 10, 10), nodeAt(l, -1, 10, 10), nodeAt(l, 2, 10, 10)]).size).toBe(3);
    const s = fac(l, 'railStation', -1, 10, 10);
    const t = fac(s.l, 'terminal', 0, 30, 10);
    expect(findPedestrianRoute(t.l, t.l.facilities[s.id]!, t.l.facilities[t.id]!)).toBeNull();
  });

  it('エレベーター/階段/エスカレーターで接続すると経路ができ、切断で消え、再接続で戻る。往復の所要時間が一致する', () => {
    let l = twoLevels();
    const s = fac(l, 'railStation', -1, 10, 10);
    const t = fac(s.l, 'terminal', 0, 30, 10);
    l = t.l;
    const A = l.facilities[s.id]!;
    const B = l.facilities[t.id]!;
    // 駅側(-1, x=10)と地上の同位置ノードをエレベーターで接続 → 駅 → 地上の x=10 → 歩いて x=30 のターミナル
    const kinds = ['elevator', 'stairs', 'escalator'] as const;
    const times: number[] = [];
    for (const kind of kinds) {
      const c = must(connectRoadLevels(l, nodeAt(l, -1, 10, 10), nodeAt(l, 0, 10, 10), { roadClass: 'walkway', connectorKind: kind, capacityPerHour: 300 }));
      const fwd = findPedestrianRoute(c.layout, A, B);
      const back = findPedestrianRoute(c.layout, B, A);
      expect(fwd, kind).not.toBeNull();
      expect(back, kind).not.toBeNull();
      expect(back!.minutes, kind).toBeCloseTo(fwd!.minutes, 9);
      expect(fwd!.capacityPerHour, kind).toBe(300); // 経路上の最小能力（コネクタ 300 < 通路 600）
      times.push(fwd!.minutes);
      // 切断
      const cut = must(deleteEntity(c.layout, c.created[0]!));
      expect(findPedestrianRoute(cut.layout, A, B), `${kind} cut`).toBeNull();
      // 再接続
      const re = must(connectRoadLevels(cut.layout, nodeAt(l, -1, 10, 10), nodeAt(l, 0, 10, 10), { roadClass: 'walkway', connectorKind: kind, capacityPerHour: 300 }));
      expect(findPedestrianRoute(re.layout, A, B)!.minutes, `${kind} reconnect`).toBeCloseTo(fwd!.minutes, 9);
    }
    expect(times[0]).toBeGreaterThan(0);
  });

  it('建設中(underConstruction)のコネクタ・片側閉鎖(oneWay)は歩行経路の扱いが正しい', () => {
    let l = twoLevels();
    const s = fac(l, 'railStation', -1, 10, 10);
    const t = fac(s.l, 'terminal', 0, 30, 10);
    l = t.l;
    const A = l.facilities[s.id]!;
    const B = l.facilities[t.id]!;
    const uc = must(connectRoadLevels(l, nodeAt(l, -1, 10, 10), nodeAt(l, 0, 10, 10), { roadClass: 'walkway', connectorKind: 'elevator', buildState: 'underConstruction' }));
    expect(findPedestrianRoute(uc.layout, A, B), '建設中は使えない').toBeNull();
    const op = must(connectRoadLevels(l, nodeAt(l, -1, 10, 10), nodeAt(l, 0, 10, 10), { roadClass: 'walkway', connectorKind: 'elevator' }));
    // oneWay: 駅(下)→地上は通れるが、地上→駅は通れない（コネクタの from 側 = 下階）
    const ow = must(updateEntity(op.layout, op.created[0]!, { oneWay: true }));
    const up = findPedestrianRoute(ow.layout, A, B);
    const down = findPedestrianRoute(ow.layout, B, A);
    expect(up !== null && down === null || up === null && down !== null, `片方向のみ到達できる (up=${!!up}, down=${!!down})`).toBe(true);
  });

  it('不正な接続は拒否: 同一階 / 種別不一致 / 短すぎるランプ / 長すぎる階段 / 存在しないノード / 既存と重複', () => {
    const l = twoLevels();
    const g = nodeAt(l, 0, 10, 10);
    const u = nodeAt(l, -1, 10, 10);
    const g2 = nodeAt(l, 0, 30, 10);
    const u2 = nodeAt(l, -1, 30, 10);
    expect(connectRoadLevels(l, g, g2, { roadClass: 'walkway', connectorKind: 'elevator' })).toEqual({ ok: false, reason: 'LEVEL_MISMATCH' });
    expect(connectRoadLevels(l, g, u, { roadClass: 'walkway', connectorKind: 'ramp' })).toEqual({ ok: false, reason: 'INVALID_CONNECTOR' });
    expect(connectRoadLevels(l, g, u, { roadClass: 'public', connectorKind: 'elevator' })).toEqual({ ok: false, reason: 'INVALID_CONNECTOR' });
    expect(connectRoadLevels(l, g, u2, { roadClass: 'walkway', connectorKind: 'stairs' })).toEqual({ ok: false, reason: 'INVALID_CONNECTOR' }); // 20 タイル=500 m > 25 m
    expect(connectRoadLevels(l, g, 'rn_9999', { roadClass: 'walkway', connectorKind: 'stairs' })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    expect(connectRoadLevels(l, g, u, { roadClass: 'walkway', connectorKind: 'stairs', capacityPerHour: -1 })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    const ok1 = must(connectRoadLevels(l, g, u, { roadClass: 'walkway', connectorKind: 'stairs' }));
    expect(connectRoadLevels(ok1.layout, g, u, { roadClass: 'walkway', connectorKind: 'stairs' })).toEqual({ ok: false, reason: 'NO_CHANGE' });
    expect(connectRoadLevels(ok1.layout, u, g, { roadClass: 'walkway', connectorKind: 'elevator' })).toEqual({ ok: false, reason: 'NO_CHANGE' });
    expect(u2).toBeDefined();
  });

  it('コネクタなしで異階ノードを結んだ手作りデータは ROAD_LAYER_CONNECTION_INVALID（error）として検出される', () => {
    const l = structuredClone(twoLevels());
    const g = nodeAt(l, 0, 10, 10);
    const u = nodeAt(l, -1, 10, 10);
    l.roads['rd_900'] = { id: 'rd_900', from: g, to: u, name: '', roadClass: 'walkway', oneWay: false, buildState: 'operational' };
    const hits = issuesFor(l, 'ROAD_LAYER_CONNECTION_INVALID', 'rd_900');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe('error');
  });
});

describe('ID04 保存往復（階層・内部設備・コネクタ）とランダム多層配置', () => {
  for (const seed of ['a4-s1', 'a4-s2', 'a4-s3']) {
    it(`seed=${seed}: ランダムな多層配置 → export/import で完全一致、検証結果が一致、2 度目の import-export は不動点`, { timeout: 120_000 }, () => {
      const rng = new Rng(seed);
      let l = emptyLayout(100, 80);
      const kinds: FacilityKind[] = ['parking', 'gseBase', 'maintenance', 'fuelFarm', 'serviceArea', 'tower'];
      const terminals: string[] = [];
      let placed = 0;
      for (let i = 0; i < 160; i++) {
        const x = rng.int(3, 90);
        const y = rng.int(3, 70);
        const kind = rng.int(0, 7) === 0 ? 'terminal' : kinds[rng.int(0, kinds.length - 1)]!;
        const lv = rng.int(-3, 3);
        const useParent = kind !== 'terminal' && terminals.length > 0 && rng.int(0, 2) === 0;
        const r = useParent
          ? (() => {
              const pid = terminals[rng.int(0, terminals.length - 1)]!;
              const p = l.facilities[pid]!;
              return placeFacility(l, kind, { x: p.origin.x + rng.int(0, 2), y: p.origin.y + rng.int(0, 2) }, { parentFacilityId: pid, floorIndex: rng.int(0, Number(p.props.levels ?? 1) - 1) });
            })()
          : placeFacility(l, kind, { x, y }, { mapLevel: lv, ...(kind === 'terminal' ? { w: 8, h: 6, props: { levels: rng.int(1, 4) } } : {}) });
        if (!r.ok) continue;
        placed++;
        l = r.layout;
        if (kind === 'terminal' && !useParent) terminals.push(r.created[0]!);
      }
      // 道路も多層に
      for (let i = 0; i < 12; i++) {
        const lv = rng.int(-2, 3);
        const y = rng.int(5, 70);
        const r = addRoadPath(l, [{ x: 5, y }, { x: 40 + rng.int(0, 40), y }], { roadClass: 'walkway', level: lv, capacityPerHour: 100 * rng.int(1, 9) });
        if (r.ok) l = r.layout;
      }
      expect(placed).toBeGreaterThan(40);
      const json = exportLayout(l);
      const back = importLayout(json);
      expect(JSON.stringify(back)).toBe(JSON.stringify(l));
      expect(exportLayout(back)).toBe(json);
      const a1 = analyzeLayout(l).issues.map((i) => `${i.code}|${i.targets.join(',')}`).sort();
      const a2 = analyzeLayout(back).issues.map((i) => `${i.code}|${i.targets.join(',')}`).sort();
      expect(a2).toEqual(a1);
      // 子の整合: 親が存在し、床番号が範囲内、mapLevel は親と一致
      for (const f of Object.values(back.facilities)) {
        if (!f.parentFacilityId) continue;
        const p = back.facilities[f.parentFacilityId];
        expect(p, `${seed} ${f.id}`).toBeDefined();
        expect(f.floorIndex!).toBeLessThan(Number(p!.props.levels ?? 1));
        expect(f.mapLevel ?? 0).toBe(p!.mapLevel ?? 0);
      }
    });
  }
});
