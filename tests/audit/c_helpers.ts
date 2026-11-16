/** 監査 c 系の共通補助（tests/audit/c_*.audit.test.ts から使う。製品コード・既存テストは変更しない） */
import { createHash } from 'node:crypto';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createSandboxCompany, type CompanyState } from '../../src/core/economy/company';
import { createSimulation, stepSimulation, type Simulation, type CreateOptions } from '../../src/core/sim/simulation';
import { checkInvariants } from '../../src/core/sim/invariants';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../src/core/io/project';
import { DAY_SEC } from '../../src/core/sim/rules';
import type { AirportLayout } from '../../src/core/model/types';

export { DAY_SEC };

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** キー順に依存しない正規化 JSON（保存・復元でオブジェクトのキー順が変わっても等価と見なす。state はバイト一致、company は toEqual 相当） */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
export const stateHash = (sim: Simulation): string => sha(JSON.stringify(sim.state) + '|' + canon(sim.company ?? null));

export function sampleSim(opts: CreateOptions & { sandbox?: boolean } = {}): Simulation {
  const { sandbox = true, ...rest } = opts;
  return createSimulation(createSampleAirport(), { ...(sandbox ? { company: createSandboxCompany() } : {}), ...rest });
}

/** 不変条件を everyN ティックごとに確認しながら進める。違反は label・now 付きで例外にする */
export function runChecked(sim: Simulation, ticks: number, everyN = 60, label = ''): void {
  for (let i = 0; i < ticks; i++) {
    stepSimulation(sim);
    if (i % everyN === 0) {
      const v = checkInvariants(sim);
      if (v.length) throw new Error(`${label} t=${sim.state.now} step=${i}: ${v.slice(0, 5).join(' / ')}`);
    }
  }
}

export function runUntilTime(sim: Simulation, t: number, everyN = 60, label = ''): void {
  runChecked(sim, Math.max(0, t - sim.state.now), everyN, label);
}

/** 保存 → 検証 → 復元（プロジェクト形式の往復） */
export function roundTrip(sim: Simulation, layout: AirportLayout = sim.ctx.layout): { sim: Simulation; json: string; warnings: string[] } {
  const json = serializeProject(buildProject({ name: 'rt', savedAt: '', layout, company: sim.company ?? createSandboxCompany(), pin: null, scenarios: [], sim }));
  const r = validateProject(json, { fallbackCompany: createSandboxCompany() });
  if (r.errors.length || !r.project) throw new Error(`validate: ${r.errors.join(' / ')}`);
  if (!r.project.sim) throw new Error(`sim snapshot dropped; warnings=${r.warnings.join(' / ')}`);
  const restored = restoreSimulation(r.project.layout, r.project.sim, effectiveModels(r.project.catalog));
  if (restored.violations.length) throw new Error(`restore violations: ${restored.violations.join(' / ')}`);
  return { sim: restored.sim, json, warnings: r.warnings };
}

/** 資金を含めた台帳の自己整合（post の合計 = 収支） */
export const todayNet = (c: CompanyState): number => Object.values(c.today).reduce((a, b) => a + (b ?? 0), 0);
