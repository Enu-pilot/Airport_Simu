/**
 * 監査 docs/38 ID 02（建設操作）— 配置・移動・回転・削除・複製・Undo/Redo・建設費/払い戻し。
 * 既存: tests/unit/history.test.ts, editor.free.test.ts, economy.test.ts（constructionCost）, validation*.test.ts。
 * 追加: シード付きランダム編集列（グリッド8方位/自由形の滑走路、誘導路、スポット、施設）に対し、
 *   - 失敗した操作が入力レイアウトを変えない（不変性）/ 成功時も入力を破壊しない
 *   - 各ステップで analyzeLayout が例外を投げない、全 ID が重複しない（接頭辞ごとの Record キー = id）
 *   - カウンタ単調（ID の再利用なし）、誘導路の端点ノードが存在する
 *   - Undo/Redo の往復で完全一致、HISTORY_LIMIT の挙動
 *   - 建設費: 配置→削除の往復で資金が増えない（refundRate < 1）、資金不足なら拒否
 */
import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, commit, createHistory, HISTORY_LIMIT, redo, undo } from '../../src/core/editor/history';
import { BALANCE } from '../../src/core/economy/balance';
import { createSandboxCompany } from '../../src/core/economy/company';
import { chargeConstruction, constructionCost, layoutItems, layoutValue } from '../../src/core/economy/construction';
import {
  addTaxiwayPath,
  deleteEntity,
  duplicateEntity,
  moveEntity,
  placeFacility,
  placeFreeRunway,
  placeRunway,
  placeStand,
  rotateEntity,
  updateEntity,
  type OpResult,
} from '../../src/core/layout/operations';
import type { AirportLayout, Heading } from '../../src/core/model/types';
import { Rng } from '../../src/core/rng';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { analyzeLayout } from '../../src/core/validation/validate';
import { emptyLayout } from '../unit/helpers';

const SEEDS = ['a2-s1', 'a2-s2', 'a2-s3', 'a2-s4'];
const FACILITY_KINDS = ['apron', 'terminal', 'hangar', 'tower', 'maintenance', 'fuelFarm', 'fireStation', 'gseBase', 'baggageSort', 'serviceArea', 'parking'] as const;
const HEADINGS: Heading[] = [0, 45, 90, 135, 180, 225, 270, 315];

/** レイアウト全体の ID 検査: Record キー = id、エンティティ種別をまたいで ID が重複しない、誘導路/道路の端点ノードが存在する */
function checkStructure(l: AirportLayout): string[] {
  const out: string[] = [];
  const all = new Map<string, string>();
  const reg = (kind: string, rec: Record<string, { id: string }>) => {
    for (const [k, v] of Object.entries(rec)) {
      if (k !== v.id) out.push(`${kind}: key ${k} != id ${v.id}`);
      const prev = all.get(v.id);
      if (prev) out.push(`id ${v.id} duplicated in ${prev} and ${kind}`);
      all.set(v.id, kind);
    }
  };
  reg('runway', l.runways);
  reg('taxiNode', l.taxiNodes);
  reg('taxiway', l.taxiways);
  reg('roadNode', l.roadNodes);
  reg('road', l.roads);
  reg('stand', l.stands);
  reg('facility', l.facilities);
  reg('terminalArea', l.terminalAreas);
  for (const e of Object.values(l.taxiways)) if (!l.taxiNodes[e.from] || !l.taxiNodes[e.to]) out.push(`taxiway ${e.id} dangling`);
  for (const e of Object.values(l.roads)) if (!l.roadNodes[e.from] || !l.roadNodes[e.to]) out.push(`road ${e.id} dangling`);
  for (const a of Object.values(l.terminalAreas)) if (!l.facilities[a.terminalId]) out.push(`area ${a.id} orphan of ${a.terminalId}`);
  return out;
}

interface Run {
  layout: AirportLayout;
  okOps: number;
  failedOps: number;
  byOp: Record<string, number>;
  trace: string[];
  everIds: Set<string>;
  dupIds: string[];
  log: { before: AirportLayout; after: AirportLayout; op: string }[];
}

/** シード付きランダム編集。失敗する操作も混ぜる（範囲外・存在しない ID・同位置）。毎ステップ検査する */
function randomEdits(seed: string, steps: number, start?: AirportLayout): Run {
  const rng = new Rng(seed);
  let l = start ?? emptyLayout(140, 100);
  const run: Run = { layout: l, okOps: 0, failedOps: 0, byOp: {}, trace: [], everIds: new Set(), dupIds: [], log: [] };
  const ids = (): string[] => [...Object.keys(l.runways), ...Object.keys(l.stands), ...Object.keys(l.facilities), ...Object.keys(l.taxiways), ...Object.keys(l.terminalAreas)];
  const pt = () => ({ x: rng.int(2, 130), y: rng.int(2, 90) });
  for (let i = 0; i < steps; i++) {
    const kind = rng.int(0, 11);
    const target = ids().length ? ids()[rng.int(0, ids().length - 1)]! : 'rwy_999';
    const before = JSON.stringify(l);
    const beforeObj = l;
    let r: OpResult;
    let name: string;
    switch (kind) {
      case 0: name = 'placeRunway'; r = placeRunway(l, pt(), HEADINGS[rng.int(0, 7)]!, rng.int(5, 60), { surfaceWidthM: ([30, 45, 60] as const)[rng.int(0, 2)]! }); break;
      case 1: name = 'placeFreeRunway'; r = placeFreeRunway(l, { start: { x: rng.int(2, 120) + rng.next(), y: rng.int(2, 90) + rng.next() }, headingDeg: rng.int(0, 359), lengthM: rng.int(300, 2500) }, { surfaceWidthM: 45 }); break;
      case 2: name = 'addTaxiwayPath'; r = addTaxiwayPath(l, [pt(), pt(), pt()].slice(0, rng.int(2, 3))); break;
      case 3: name = 'placeStand'; r = placeStand(l, pt(), (['S', 'M', 'L'] as const)[rng.int(0, 2)]!, ([0, 90, 180, 270] as const)[rng.int(0, 3)]!); break;
      case 4: name = 'placeFacility'; r = placeFacility(l, FACILITY_KINDS[rng.int(0, FACILITY_KINDS.length - 1)]!, pt()); break;
      case 5: name = 'moveEntity'; r = moveEntity(l, target, { x: rng.int(-6, 6), y: rng.int(-6, 6) }); break;
      case 6: name = 'rotateEntity'; r = rotateEntity(l, target, rng.int(1, 4) * 15); break;
      case 7: name = 'deleteEntity'; r = deleteEntity(l, target); break;
      case 8: name = 'duplicateEntity'; r = duplicateEntity(l, target); break;
      case 9: name = 'updateEntity'; r = updateEntity(l, target, { name: `n${i}` }); break;
      case 10: name = 'deleteNonexistent'; r = deleteEntity(l, 'std_9999'); break;
      default: name = 'moveZero'; r = moveEntity(l, target, { x: 0, y: 0 }); break;
    }
    run.byOp[name] = (run.byOp[name] ?? 0) + 1;
    // 不変性: 入力は成功・失敗にかかわらず変化しない
    expect(JSON.stringify(beforeObj), `${seed}#${i} ${name} mutated its input`).toBe(before);
    if (!r.ok) {
      run.failedOps++;
      continue;
    }
    run.okOps++;
    for (const id of r.created) {
      if (run.everIds.has(id)) run.dupIds.push(id);
      run.everIds.add(id);
    }
    run.log.push({ before: beforeObj, after: r.layout, op: name });
    run.trace.push(`${i}:${name}`);
    l = r.layout;
    const st = checkStructure(l);
    if (st.length) throw new Error(`${seed}#${i} ${name} (${run.trace.slice(-5).join(',')}): ${st.join(' | ')}`);
    // 検証が例外を投げない（毎ステップではなく 4 回に 1 回 + 最後。コスト抑制）
    if (i % 4 === 0) expect(() => analyzeLayout(l), `${seed}#${i} ${name}`).not.toThrow();
  }
  run.layout = l;
  return run;
}

describe('ID02 ランダム編集列: 不変性・ID の一意性・検証が例外を投げない', () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}: 空の敷地から 220 操作`, { timeout: 180_000 }, () => {
      const r = randomEdits(seed, 220);
      expect(r.okOps, `ok=${r.okOps} failed=${r.failedOps} ${JSON.stringify(r.byOp)}`).toBeGreaterThan(60);
      expect(r.failedOps).toBeGreaterThan(5); // 失敗経路も通っている
      expect(r.dupIds, 'ID が再利用された').toEqual([]);
      expect(() => analyzeLayout(r.layout)).not.toThrow();
      // カウンタは単調で、既存 ID の番号以上
      for (const [prefix, n] of Object.entries(r.layout.counters)) {
        const used = [...Object.keys(r.layout.runways), ...Object.keys(r.layout.stands), ...Object.keys(r.layout.facilities), ...Object.keys(r.layout.taxiways), ...Object.keys(r.layout.taxiNodes), ...Object.keys(r.layout.terminalAreas)]
          .filter((id) => id.startsWith(`${prefix}_`))
          .map((id) => Number(id.slice(prefix.length + 1)));
        for (const u of used) expect(n, `${seed} counter ${prefix}`).toBeGreaterThanOrEqual(u);
      }
    });
  }

  it('seed=a2-sample: サンプル空港に対する 150 操作（既存の複雑なレイアウト上）でも壊れない', { timeout: 180_000 }, () => {
    const r = randomEdits('a2-sample', 150, createSampleAirport());
    expect(r.okOps).toBeGreaterThan(30);
    expect(r.dupIds).toEqual([]);
    expect(() => analyzeLayout(r.layout)).not.toThrow();
  });
});

describe('ID02 Undo/Redo: 編集列を全て戻し/やり直すと完全一致', () => {
  for (const seed of SEEDS.slice(0, 3)) {
    it(`seed=${seed}: 成功した全操作を commit → undo 全回 = 初期 / redo 全回 = 最終（参照も同一）`, { timeout: 120_000 }, () => {
      const r = randomEdits(seed, 120);
      let h = createHistory(r.log[0]!.before);
      for (const e of r.log) h = commit(h, e.after);
      const final = h.present;
      expect(h.past.length).toBe(Math.min(r.log.length, HISTORY_LIMIT));
      let steps = 0;
      while (canUndo(h)) {
        h = undo(h);
        steps++;
      }
      expect(steps).toBe(r.log.length);
      expect(JSON.stringify(h.present)).toBe(JSON.stringify(r.log[0]!.before));
      expect(h.future.length).toBe(r.log.length);
      while (canRedo(h)) h = redo(h);
      expect(h.present).toBe(final);
      // 途中で新しい編集を commit すると Redo は破棄される
      h = undo(undo(h));
      const edited = placeStand(h.present, { x: 3, y: 3 }, 'M');
      expect(edited.ok).toBe(true);
      if (edited.ok) h = commit(h, edited.layout);
      expect(canRedo(h)).toBe(false);
    });
  }

  it('HISTORY_LIMIT を超える commit は古い履歴から捨て、直近 LIMIT 回の Undo が可能', () => {
    let l = emptyLayout(60, 60);
    let h = createHistory(l);
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) {
      const r = placeStand(l, { x: 2 + (i % 50), y: 2 + Math.floor(i / 50) }, 'M');
      if (!r.ok) throw new Error('place failed');
      l = r.layout;
      h = commit(h, l);
    }
    expect(h.past.length).toBe(HISTORY_LIMIT);
    let n = 0;
    while (canUndo(h)) {
      h = undo(h);
      n++;
    }
    expect(n).toBe(HISTORY_LIMIT);
    expect(Object.keys(h.present.stands).length).toBe(25);
  });
});

describe('ID02 建設費・払い戻し', () => {
  const C = BALANCE.construction;
  it('refundRate < 1: 配置→削除の往復で資金が増えない（seeds 4, 各 40 要素）', () => {
    expect(C.refundRate).toBeLessThan(1);
    for (const seed of SEEDS) {
      const rng = new Rng(`${seed}:cost`);
      let l = emptyLayout(140, 100);
      const c = createSandboxCompany(seed);
      const cash0 = c.cash;
      const placed: AirportLayout[] = [];
      for (let i = 0; i < 40; i++) {
        const r =
          i % 3 === 0
            ? placeRunway(l, { x: rng.int(2, 100), y: rng.int(2, 90) }, HEADINGS[rng.int(0, 7)]!, rng.int(10, 40))
            : i % 3 === 1
              ? placeStand(l, { x: rng.int(2, 130), y: rng.int(2, 90) }, 'M')
              : placeFacility(l, FACILITY_KINDS[rng.int(0, FACILITY_KINDS.length - 1)]!, { x: rng.int(2, 120), y: rng.int(2, 85) });
        if (!r.ok) continue;
        const ch = chargeConstruction(c, l, r.layout);
        expect(ch.ok).toBe(true);
        l = r.layout;
        placed.push(l);
      }
      expect(c.cash, seed).toBeLessThan(cash0);
      const afterBuild = c.cash;
      // 全削除
      for (const id of [...Object.keys(l.runways), ...Object.keys(l.stands), ...Object.keys(l.facilities)]) {
        const r = deleteEntity(l, id);
        if (!r.ok) continue;
        const ch = chargeConstruction(c, l, r.layout);
        expect(ch.ok).toBe(true);
        expect(ch.cost, `${seed} delete ${id} must refund (cost<=0)`).toBeLessThanOrEqual(0);
        l = r.layout;
      }
      expect(c.cash, `${seed} refunds exceed outlay`).toBeLessThanOrEqual(cash0);
      expect(c.cash).toBeGreaterThan(afterBuild);
      // 台帳に construction が記録される
      expect(c.today.construction).toBeDefined();
      expect(c.today.construction).toBeCloseTo(c.cash - cash0, 0);
    }
  });

  it('資金不足の編集は拒否され、資金・台帳が変わらない / 払い戻しは資金ゼロでも可能', () => {
    const c = createSandboxCompany('a2-poor');
    c.cash = 10;
    const l0 = emptyLayout(60, 60);
    const r = placeRunway(l0, { x: 5, y: 20 }, 90, 30);
    if (!r.ok) throw new Error('x');
    const ch = chargeConstruction(c, l0, r.layout);
    expect(ch).toMatchObject({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    expect(c.cash).toBe(10);
    expect(c.today.construction).toBeUndefined();
    const del = deleteEntity(r.layout, Object.keys(r.layout.runways)[0]!);
    if (!del.ok) throw new Error('y');
    const refund = chargeConstruction(c, r.layout, del.layout);
    expect(refund.ok).toBe(true);
    expect(c.cash).toBeGreaterThan(10);
  });

  it('layoutItems の合計 = layoutValue / planned は 0 円 / 同じレイアウト間のコストは 0 / 往復コストは正と負で対称でない（返金率）', () => {
    const l = createSampleAirport();
    expect(layoutValue(l)).toBe(Object.values(layoutItems(l)).reduce((a, b) => a + b, 0));
    expect(constructionCost(l, l)).toBe(0);
    const added = placeStand(l, { x: 3, y: 3 }, 'L');
    const planned = placeStand(l, { x: 3, y: 3 }, 'L', 0, 'planned');
    if (!added.ok || !planned.ok) throw new Error('place');
    expect(constructionCost(l, planned.layout)).toBe(0);
    const up = constructionCost(l, added.layout);
    const down = constructionCost(added.layout, l);
    expect(up).toBeGreaterThan(0);
    expect(down).toBeLessThan(0);
    expect(Math.abs(down)).toBeLessThan(up);
  });
});

describe('ID02 グリッド8方位 vs 自由形の滑走路: 移動・回転・複製・削除', () => {
  it('回転 8 回でグリッド滑走路は元の向きに戻り、自由形は 24 回(15°)で 360° 戻る。移動→逆移動で元の位置', () => {
    let l = emptyLayout(140, 100);
    const g = placeRunway(l, { x: 20, y: 40 }, 90, 40);
    if (!g.ok) throw new Error('grid');
    l = g.layout;
    const gid = g.created[0]!;
    const f = placeFreeRunway(l, { start: { x: 30, y: 60 }, headingDeg: 20, lengthM: 1200 });
    if (!f.ok) throw new Error('free');
    l = f.layout;
    const fid = f.created[0]!;
    const gr0 = JSON.stringify(l.runways[gid]);
    let cur = l;
    for (let i = 0; i < 8; i++) {
      const r = rotateEntity(cur, gid);
      if (!r.ok) throw new Error(`rotate grid ${i}: ${r.reason}`);
      cur = r.layout;
    }
    expect(JSON.stringify(cur.runways[gid])).toBe(gr0);
    const fr0 = l.runways[fid] as { headingDeg: number; start: { x: number; y: number }; lengthM: number };
    for (let i = 0; i < 24; i++) {
      const r = rotateEntity(cur, fid, 15);
      if (!r.ok) throw new Error(`rotate free ${i}: ${r.reason}`);
      cur = r.layout;
    }
    const fr1 = cur.runways[fid] as typeof fr0;
    expect(fr1.lengthM).toBeCloseTo(fr0.lengthM, 6);
    expect(((fr1.headingDeg - fr0.headingDeg + 540) % 360) - 180).toBeCloseTo(0, 6);
    expect(fr1.start.x).toBeCloseTo(fr0.start.x, 6);
    expect(fr1.start.y).toBeCloseTo(fr0.start.y, 6);
    for (const id of [gid, fid]) {
      const m = moveEntity(cur, id, { x: 7, y: -3 });
      if (!m.ok) throw new Error('move');
      const back = moveEntity(m.layout, id, { x: -7, y: 3 });
      if (!back.ok) throw new Error('moveback');
      expect(JSON.stringify(back.layout.runways[id])).toBe(JSON.stringify(cur.runways[id]));
      const d = duplicateEntity(back.layout, id);
      if (!d.ok) throw new Error('dup');
      expect(d.created[0]).not.toBe(id);
      expect(Object.keys(d.layout.runways).length).toBe(Object.keys(cur.runways).length + 1);
      const del = deleteEntity(d.layout, d.created[0]!);
      expect(del.ok && Object.keys(del.layout.runways).length).toBe(Object.keys(cur.runways).length);
    }
  });
});
