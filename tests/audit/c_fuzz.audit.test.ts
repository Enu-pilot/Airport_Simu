/**
 * 監査 c / ID20: seed 付きランダム操作（障害の追加・修理、スポット変更、遅延、優先、欠航、手動閉鎖、ランダムなチャンクの stepTicks）。
 * 失敗時は seed・step 番号・直前の操作を含むメッセージで再現できる。同じ seed 2 回で状態ハッシュが一致（決定性）。
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { stateHash, DAY_SEC } from './c_helpers';
import { addDisruption, resolveDisruption, reassignStand, delayFlight, prioritize, setManualResourceClosure } from '../../src/core/sim/disruptions';
import { cancelFlightEarly } from '../../src/core/sim/simulation';
import { stepTicks } from '../../src/core/sim/dayloop';
import { checkInvariants } from '../../src/core/sim/invariants';
import { deleteEntity } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSimulation, type Simulation } from '../../src/core/sim/simulation';
import { createSandboxCompany } from '../../src/core/economy/company';
import type { DisruptionKind } from '../../src/core/sim/types';

const SEEDS = ['c-fz-1', 'c-fz-2', 'c-fz-3', 'c-fz-4', 'c-fz-5'];
const KINDS: DisruptionKind[] = ['runwayClosed', 'taxiwayClosed', 'standClosed', 'gateFailure', 'vehicleFailure', 'staffAbsence', 'demandSurge', 'weather'];

function build(seed: string): Simulation {
  const rng = new Rng(`${seed}:build`);
  let layout = createSampleAirport();
  // ランダムな建設編集: スポットを 0〜2 個削除（成功した操作だけ反映）
  for (let i = rng.int(0, 2); i > 0; i--) {
    const ids = Object.keys(layout.stands);
    if (ids.length <= 4) break;
    const r = deleteEntity(layout, ids[rng.int(0, ids.length - 1)]!);
    if (r.ok) layout = r.layout;
  }
  return createSimulation(layout, { seed, company: createSandboxCompany(seed) });
}

function fuzz(seed: string, steps: number): { hash: string; log: string[] } {
  const sim = build(seed);
  const rng = new Rng(`${seed}:ops`);
  const log: string[] = [];
  const pick = <T,>(a: T[]): T => a[rng.int(0, a.length - 1)]!;
  for (let step = 0; step < steps; step++) {
    const op = rng.int(0, 9);
    const st = sim.state;
    let desc = `op${op}`;
    const flights = Object.values(st.flights);
    const acs = Object.values(st.aircraft).filter((a) => a.state !== 'scheduled');
    if (op <= 2) {
      const kind = pick(KINDS);
      const l = sim.ctx.layout;
      const target = kind === 'runwayClosed' ? pick(Object.keys(l.runways)) : kind === 'taxiwayClosed' ? pick(Object.keys(l.taxiways)) : kind === 'standClosed' ? pick(Object.keys(l.stands)) : kind === 'gateFailure' ? pick(Object.values(l.facilities).filter((f) => f.kind === 'gate').map((f) => f.id)) : kind === 'vehicleFailure' || kind === 'staffAbsence' ? pick(Object.keys(st.units)) : null;
      desc = `add ${kind} ${target}`;
      addDisruption(sim, { kind, targetId: target, ...(kind === 'weather' ? { weather: pick(['rain', 'snow', 'fog'] as const) } : {}), ...(kind === 'demandSurge' ? { amount: 1.4 } : {}), end: st.now + rng.int(300, 3600) });
    } else if (op === 3) {
      const d = st.disruptions.filter((x) => x.status !== 'resolved');
      if (d.length) { const x = pick(d); desc = `resolve ${x.id}`; resolveDisruption(sim, x.id); }
    } else if (op === 4 && acs.length) {
      const a = pick(acs); const s = pick(Object.keys(sim.ctx.layout.stands)); desc = `reassign ${a.id}->${s}`; reassignStand(sim, a.id, s);
    } else if (op === 5 && flights.length) {
      const f = pick(flights); desc = `delay ${f.id}`; delayFlight(sim, f.id, rng.int(1, 60));
    } else if (op === 6 && acs.length) {
      const a = pick(acs); desc = `prio ${a.id}`; prioritize(sim, a.id, rng.next() < 0.5);
    } else if (op === 7 && acs.length) {
      const a = pick(acs); desc = `cancel ${a.id}`; cancelFlightEarly(sim, a.id);
    } else if (op === 8) {
      const standId = pick(Object.keys(sim.ctx.layout.stands)); const closed = rng.next() < 0.6; desc = `manual stand ${standId} ${closed}`; setManualResourceClosure(sim, 'stand', standId, closed);
    }
    const chunk = rng.int(1, 900);
    log.push(`${step}:${desc}+${chunk}`);
    stepTicks(sim, chunk, { stopAtDayClose: rng.next() < 0.1 });
    const v = checkInvariants(sim);
    if (v.length) throw new Error(`seed=${seed} step=${step} t=${st.now} op=[${desc}] violations: ${v.slice(0, 4).join(' / ')}\nlast ops: ${log.slice(-6).join(' | ')}`);
  }
  return { hash: stateHash(sim), log };
}

describe('ID20 ランダム操作（5 seed × 60 ステップ）', () => {
  for (const seed of SEEDS) {
    it(`seed=${seed}: 不変条件を保つ。同じ seed の 2 回目は状態ハッシュが一致`, () => {
      const a = fuzz(seed, 60);
      const b = fuzz(seed, 60);
      expect(b.log).toEqual(a.log);
      expect(b.hash).toBe(a.hash);
    });
  }
  it('1 日スキップ相当（大きなチャンク）と細かいチャンクで同じ総ティック数を進めると結果が一致（チャンク分割の独立性）', () => {
    const a = build('c-chunk');
    const b = build('c-chunk');
    stepTicks(a, 7200);
    let left = 7200;
    const r = new Rng('c-chunk:sizes');
    while (left > 0) { const n = Math.min(left, r.int(1, 500)); stepTicks(b, n); left -= n; }
    expect(stateHash(b)).toBe(stateHash(a));
    expect(DAY_SEC).toBe(86400);
  });
});
