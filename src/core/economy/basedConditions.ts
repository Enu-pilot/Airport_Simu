import type { SimContext } from '../sim/context';
import { BALANCE } from './balance';
import { overnightCapacity, overnightFeasible, overnightRequired } from './capacity';
import type { CompanyState } from './company';
import { analyzeDayPlan, planDayWithDemand, STAFF_PER_TURNAROUND } from './planning';
import { routeCapabilitiesForAirport } from './registry';

/**
 * 拠点契約の条件の内訳（UIデザイン更新 第3段階・§6-3。表示専用の読み取り）。
 *
 * 判定の正本は sim/overnight.ts の basedConditionsUnmet（締めで撤退判定に使う）。
 * あちらは Simulation を要求するため経営画面（建設モード）からは呼べない。
 * ここでは同じ式を (会社, 文脈, 日) だけで再計算し、「何が・どれだけ足りないか」を
 * 数値で開示する。sim の計算・判定・乱数には一切触れない（新規の純関数）。
 * basedConditionsUnmet との一致はテスト（basedConditions.test.ts）で担保する:
 * 運航中の閉鎖スポットがない状態では、未達項目の集合が完全一致すること。
 *
 * 条件（フェーズ 4 §3.5）:
 * (a) 滞泊の能力: 全契約の滞泊必要数が、運用中スポットへ大きさ適合つきで収まるか
 * (b) 整備の能力: 1 晩の整備枠 >= ceil(所属機数 × 日中の折り返し数 / 整備周期)
 * (c) 整備士: 整備施設の整備士合計 >= ceil(所属機数 / 2)
 * (d) 作業員: 地上支援の作業員合計 >= 同時折り返しピーク × 1 回あたりの必要数
 */

export type BasedConditionKey = 'overnight' | 'maintenance' | 'engineers' | 'staff';

export interface BasedConditionItem {
  key: BasedConditionKey;
  /** basedConditionsUnmet が返す名前と同一（撤退イベント・検証ラベルと対応させる） */
  name: string;
  /** 必要な数 */
  required: number;
  /** 現在の数 */
  available: number;
  unit: string;
  met: boolean;
  /** 算出根拠（推測で埋めないための明記） */
  basis: string;
}

export interface BasedConditionDetails {
  contractId: string;
  items: BasedConditionItem[];
  /** 満たさない項目の名前（basedConditionsUnmet の戻りと同じ並び・同じ文字列） */
  unmet: string[];
  allMet: boolean;
}

/** 1 晩の整備枠（sim/overnight.ts maintenanceCapacityPerNight と同じ式。端数の繰り越しは含まない条件判定用の値） */
export function maintenanceCapacityFromLayout(ctx: SimContext): number {
  let n = 0;
  for (const f of Object.values(ctx.layout.facilities)) {
    if (f.buildState !== 'operational') continue;
    if (f.kind === 'hangar') n += 1;
    else if (f.kind === 'maintenance') n += Math.floor(Number(f.props.bays ?? 0) * 0.5);
  }
  return n;
}

/** 整備士の数（sim/overnight.ts engineerCount と同じ式: 運用中の整備施設の engineers 合計） */
export function engineerCountFromLayout(ctx: SimContext): number {
  let n = 0;
  for (const f of Object.values(ctx.layout.facilities)) {
    if (f.kind === 'maintenance' && f.buildState === 'operational') n += Number(f.props.engineers ?? 0);
  }
  return n;
}

/**
 * 拠点契約 1 件の条件の内訳。拠点契約でない場合は null。
 * closedStandIds は運航中の閉鎖スポット（経営画面では通常なし = 空）。
 * 呼び出しは表示のたびに当日計画を 1 回だけ作る（basedConditionsUnmet の作業員判定と同じ手順）。
 */
export function basedConditionDetails(
  company: CompanyState,
  ctx: SimContext,
  contractId: string,
  opts?: { day?: number; closedStandIds?: readonly string[] },
): BasedConditionDetails | null {
  const k = company.contracts[contractId];
  if (!k || k.kind !== 'based') return null;
  const day = opts?.day ?? company.day;
  const closures = opts?.closedStandIds ?? [];
  const n = k.basedAircraft ?? 1;
  const items: BasedConditionItem[] = [];

  // (a) 滞泊の能力: 必要数は全契約分（overnight 契約を含む。締めの判定と同じ）
  const requiredBySize = overnightRequired(company, ctx, day);
  const requiredTotal = Object.values(requiredBySize).reduce((s, v) => s + (v ?? 0), 0);
  const capBySize = overnightCapacity(ctx, closures);
  items.push({
    key: 'overnight',
    name: '滞泊の能力',
    required: requiredTotal,
    available: capBySize.S,
    unit: '機',
    met: overnightFeasible(ctx, requiredBySize, closures),
    basis: '必要数は全契約の滞泊分（サイズ別）で、判定は大きいスポットへ小さい機も置ける貪欲な割り当て。現在数は滞泊に使えるスポット数（S クラスが入る数 = 全スポット数）で、サイズ適合の結果は判定欄に出ます',
  });

  // (b) 整備の能力
  const needChecks = Math.ceil((n * k.perDay) / BALANCE.phase4.checkCycles);
  const maintenanceCap = maintenanceCapacityFromLayout(ctx);
  items.push({
    key: 'maintenance',
    name: '整備の能力',
    required: needChecks,
    available: maintenanceCap,
    unit: '機/晩',
    met: maintenanceCap >= needChecks,
    basis: `必要数は ceil(所属機 ${n} 機 × 折り返し ${k.perDay} 回/日 ÷ 整備周期 ${BALANCE.phase4.checkCycles} 回)。現在数は格納庫 1 棟 = 1 機 + 整備施設ベイ × 0.5（端数の繰り越しなし）`,
  });

  // (c) 整備士
  const needEngineers = Math.ceil(n / 2);
  const engineers = engineerCountFromLayout(ctx);
  items.push({
    key: 'engineers',
    name: '整備士',
    required: needEngineers,
    available: engineers,
    unit: '人',
    met: engineers >= needEngineers,
    basis: `必要数は ceil(所属機 ${n} 機 ÷ 2)。現在数は運用中の整備施設の整備士の合計`,
  });

  // (d) 作業員: 当日計画の同時折り返しピーク × 1 回あたりの必要数（締めの判定と同じ計画の作り方）
  let staff = 0;
  for (const b of ctx.bases) staff += b.units.staff ?? 0;
  const plan = planDayWithDemand(company, day, 1, ctx.types, routeCapabilitiesForAirport(ctx.layout.countryId));
  const peak = analyzeDayPlan(plan, ctx).peakTurnarounds;
  const needStaff = STAFF_PER_TURNAROUND * peak;
  items.push({
    key: 'staff',
    name: '作業員',
    required: needStaff,
    available: staff,
    unit: '人',
    met: staff >= needStaff,
    basis: `必要数は同時折り返しピーク ${peak} 機 × ${STAFF_PER_TURNAROUND} 人。現在数は地上支援拠点の作業員の合計`,
  });

  const unmet = items.filter((i) => !i.met).map((i) => i.name);
  return { contractId, items, unmet, allMet: unmet.length === 0 };
}
