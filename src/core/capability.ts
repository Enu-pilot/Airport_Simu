import type { AirportLayout, Facility, FacilityKind } from './model/types';
import type { SimState } from './sim/types';
import { closureReasonsFor } from './sim/closureState';
import { overnightCapacity, overnightRequired, type CapacityMetric, type SizeClass3 } from './economy/capacity';
import type { CompanyState, DailyReport } from './economy/company';
import type { SimContext } from './sim/context';
import { BALANCE } from './economy/balance';
import { towerCapacityPerHour } from './safety';
import { verifyPortalAccess } from './terminal/networkGraph';
import { SERVICE_CATEGORIES, serviceProfilesFor, type ServiceCategory } from './terminal/serviceProfile';

/**
 * Phase 6 / F6-01: 共通能力データ契約。
 *
 * 施設・工程・分野ごとの能力を、理論能力 / 有効能力 / 需要 / 実績 / 単位 / 状態 /
 * 未算出理由に分解して表す共通の読み取り形。具体的な算出式は各領域の既存計算
 * （adapter が参照する正本）に置き、本モジュールは値を再計算しない。
 * 「未設置」「未算出」「0能力」を同じ 0 として扱わない（Phase 6 計画 §4.3）。
 */
export type CapabilityState =
  | 'notInstalled'
  | 'uncomputed'
  | 'zeroCapacity'
  | 'disconnected'
  | 'underConstruction'
  | 'closed'
  | 'failed'
  | 'resourceShortage'
  | 'supplyShortage'
  | 'operational';

export interface CapabilityReading {
  /** 分野キー（'passenger-process' / 'cargo' / 'airside' 等。表示側のグルーピング用） */
  domain: string;
  /** 対象の ID（施設 ID、工程名、指標名など） */
  subjectId: string;
  label: string;
  /** 単位文字列（'pax/h', 'm³/h', 'movements/h', 'category' 等）。異なる単位を合算しない */
  unit: string;
  /** 理論能力: 設備固有の設定から求める能力。算出できない場合は null */
  theoretical: number | null;
  /** 有効能力: 接続・稼働・閉鎖等の制約を反映した現在利用可能な能力 */
  effective: number | null;
  demand: number | null;
  actual: number | null;
  state: CapabilityState;
  /** state が uncomputed のとき、その理由（推定値で埋めない） */
  uncomputedReason?: string;
  /** 計算根拠（どの正本の式・設定から来たか） */
  basis: string;
}

/** 使用率 = 需要 ÷ 有効能力。有効能力が未算出・0、需要が未算出なら null（数値を出さない） */
export function capabilityUtilization(r: CapabilityReading): number | null {
  if (r.effective === null || r.effective <= 0 || r.demand === null) return null;
  return r.demand / r.effective;
}

const STATE_FROM_BUILD: Record<string, CapabilityState> = {
  operational: 'operational',
  underConstruction: 'underConstruction',
  planned: 'underConstruction',
};

/**
 * 既存の空港能力スナップショット指標（economy/capacity.ts）を共通契約へ写す adapter。
 * 既存モデルは理論/有効を区別しないため、capacity を両方へ写し、その旨を basis に残す。
 * 実績は計画側モデルに無いので null（未計測）。
 */
export function readingFromCapacityMetric(m: CapacityMetric, subjectId: string, domain = 'airport'): CapabilityReading {
  const state: CapabilityState = m.capacity === null ? 'uncomputed' : m.capacity <= 0 && (m.demand ?? 0) > 0 ? 'zeroCapacity' : 'operational';
  return {
    domain,
    subjectId,
    label: m.name,
    unit: m.unit,
    theoretical: m.capacity,
    effective: m.capacity,
    demand: m.demand,
    actual: null,
    state,
    ...(m.capacity === null ? { uncomputedReason: m.basis } : {}),
    basis: `${m.basis}（既存能力モデルは理論/有効を区別しないため同値）`,
  };
}

/**
 * 能力式のない種別のうち、未算出の理由が種別固有のもの（UI 改善 案3）。
 * 分類の正本は core/model/catalog の FACILITY_SIM_EFFECT。
 */
const UNCOMPUTED_REASON_BY_KIND: Partial<Record<FacilityKind, string>> = {
  fuelFarm: '貯蔵量（capacityKL）は表示のみです。在庫の消費は未実装のため、能力としては算出しません（施設の存在自体は給油の前提です）',
  serviceArea: 'この施設は現在 sim 上の効果がないため、能力は算出しません',
};

/**
 * 施設 1 件の能力（F6-02 インスペクターの正本）。
 * 能力式が定義されている種別だけ理論能力を返し、それ以外は未算出として理由を返す。
 * 有効能力は稼働状態のみを反映する（接続・人員・供給の減額源が無い種別では理論と同値）。
 * 運航中の閉鎖・故障の状態はここでは生成しない（operationalStateReadings が正本で、
 * 画面側は composeCapabilityReadings で合成する）。
 */
export function facilityCapability(f: Facility, opts?: { portalUnreachable?: boolean }): CapabilityReading {
  const base = { domain: 'facility', subjectId: f.id, label: f.name, demand: null, actual: null };
  const buildState = STATE_FROM_BUILD[f.buildState] ?? 'operational';
  const finish = (unit: string, theoretical: number | null, basis: string): CapabilityReading => {
    if (theoretical === null) {
      return { ...base, unit, theoretical: null, effective: null, state: 'uncomputed', uncomputedReason: basis, basis };
    }
    // 未接続（ポータル経路が到達不能）: 理論能力は保持し、有効能力だけを 0 にする（docs/45 §4.7 の状態区別）
    if (buildState === 'operational' && opts?.portalUnreachable) {
      return { ...base, unit, theoretical, effective: 0, state: 'disconnected', basis: `${basis}。ポータル接続が到達不能なため有効能力 0（terminal/networkGraph.ts の verifyPortalAccess）` };
    }
    const effective = buildState === 'operational' ? theoretical : 0;
    return {
      ...base,
      unit,
      theoretical,
      effective,
      state: buildState !== 'operational' ? buildState : theoretical <= 0 ? 'zeroCapacity' : 'operational',
      basis,
    };
  };
  switch (f.kind) {
    case 'cargoTerminal': {
      if (f.parentFacilityId) {
        return { ...base, unit: 'm³/h', theoretical: null, effective: null, state: 'uncomputed', uncomputedReason: '内包施設は空港合計（cargoHandlingCapacityM3PerHour）の算入対象外', basis: 'economy/cargo.ts の集約条件' };
      }
      const v = Math.max(0, Number(f.props.throughputM3PerHour ?? 0) || 0);
      return finish('m³/h', v, 'props.throughputM3PerHour（貨物上屋の荷役能力、economy/cargo.ts と同じ設定値）');
    }
    case 'busTerminal': {
      if (f.parentFacilityId) {
        return { ...base, unit: 'pax/h', theoretical: null, effective: null, state: 'uncomputed', uncomputedReason: '内包施設はアクセス能力の算入対象外', basis: 'access/model.ts の集約条件' };
      }
      const M = BALANCE.accessModel;
      const perHour = Math.min(Number(f.props.busesPerHour ?? 0) || 0, (Number(f.props.berths ?? 0) || 0) * M.busesPerBay);
      return finish('pax/h', perHour * M.busSeats, `min(busesPerHour, berths × ${M.busesPerBay}) × 定員 ${M.busSeats}（access/model.ts と同じ式）`);
    }
    case 'tower': {
      const level = Number(f.props.level ?? 1) || 0;
      return finish('movements/h', towerCapacityPerHour(level), `管制塔レベル ${level} の目安（safety.ts。助言用で運航は止めない）`);
    }
    case 'fireStation': {
      const category = Number(f.props.category ?? 7);
      return finish('category', category, 'props.category（空港消防カテゴリは全消防施設の最大値、safety.ts）');
    }
    default:
      return {
        ...base,
        unit: '',
        theoretical: null,
        effective: null,
        state: 'uncomputed',
        uncomputedReason: UNCOMPUTED_REASON_BY_KIND[f.kind] ?? 'この施設種別には能力式が定義されていない',
        basis: 'Phase 6 計画 §4.1: 根拠のない能力は推定で埋めない',
      };
  }
}

/**
 * レイアウト内の全施設の能力（未算出の施設も状態として含む）。ポータル接続の到達性も減額源として反映する。
 * 運航中の閉鎖・故障の状態は含まない（operationalStateReadings が正本。合成は composeCapabilityReadings）。
 */
export function layoutCapabilities(layout: AirportLayout): CapabilityReading[] {
  const portal = new Map(verifyPortalAccess(layout).map((s) => [s.facilityId, s]));
  return Object.values(layout.facilities).map((f) => {
    const s = portal.get(f.id);
    const portalUnreachable = s !== undefined && (s.toEntrance === 'unreachable' || s.fromExit === 'unreachable');
    return facilityCapability(f, { portalUnreachable });
  });
}

/**
 * 画面側の合成規則（F6-04 統合。全画面で同一にする）: 静的な layoutCapabilities に
 * 運航中状態の operationalStateReadings（正本）を subjectId でマージする。
 * 同じ subjectId が両方にある場合は operationalStateReadings 側を採る
 * （運航中状態が静的な稼働状態より優先）。運航していない（state が無い）ときは
 * layoutCapabilities のみで、従来表示と完全同一になる。
 */
export function composeCapabilityReadings(layout: AirportLayout, state: SimState | null | undefined): CapabilityReading[] {
  const base = layoutCapabilities(layout);
  if (!state) return base;
  const ops = operationalStateReadings(state, layout);
  if (ops.length === 0) return base;
  const opsById = new Map(ops.map((r) => [r.subjectId, r]));
  const merged = base.map((r) => opsById.get(r.subjectId) ?? r);
  const baseIds = new Set(base.map((r) => r.subjectId));
  for (const r of ops) if (!baseIds.has(r.subjectId)) merged.push(r);
  return merged;
}

/**
 * 5-21 の工程ピーク実績（DailyReport.processPeak）を共通契約へ写す adapter。
 * 能力は areaProcessingPerHour 合計（理論 = 有効。減額源は未実装のため同値と明記）、
 * 実績はピーク時間帯の処理量。
 */
export function readingsFromProcessPeak(report: DailyReport): CapabilityReading[] {
  return (report.processPeak ?? []).map((row) => ({
    domain: 'passenger-process',
    subjectId: row.step,
    label: row.step,
    unit: 'pax/h',
    theoretical: row.capacityPerHour,
    effective: row.capacityPerHour,
    demand: row.demandPerHour,
    actual: row.peakProcessed,
    state: row.capacityPerHour <= 0 ? 'zeroCapacity' : 'operational',
    basis: '5-21 工程ピーク（能力は terminal/capacity.ts の合計。有効能力の減額源は未実装のため理論と同値）',
  }));
}

const SERVICE_CATEGORY_LABEL: Record<ServiceCategory, string> = {
  retail: '店舗',
  dining: '飲食',
  lounge: 'ラウンジ',
  waiting: '待合',
};

/**
 * 旅客サービス施設（5-19 T11 の集約 profile）を共通契約へ写す adapter。
 * 単位はカテゴリで異なる: 店舗・飲食・待合は処理能力（窓口相当）、ラウンジは席数。
 * 理論 = 設置済み全施設の合計、有効 = 運用中施設の合計。需要・実績は profile の範囲外
 * （実績は aggregateServiceRecords 側）ため null とし、根拠を basis に明記する。
 */
export function readingsFromServiceProfiles(layout: AirportLayout): CapabilityReading[] {
  const profiles = serviceProfilesFor(layout);
  const out: CapabilityReading[] = [];
  for (const terminalId of profiles.terminals) {
    for (const category of SERVICE_CATEGORIES) {
      const p = profiles.byTerminalCategory.get(`${terminalId}|${category}`)!;
      const allSeatsOrServers = profiles.facilities
        .filter((f) => f.terminalId === terminalId && f.category === category)
        .reduce((s, f) => s + f.capacity, 0);
      out.push({
        domain: 'passenger-service',
        subjectId: `${terminalId}:${category}`,
        label: `${SERVICE_CATEGORY_LABEL[category]}（${terminalId}）`,
        unit: category === 'lounge' ? 'seats' : 'servers',
        theoretical: p.facilityCount > 0 ? allSeatsOrServers : null,
        effective: p.facilityCount > 0 ? p.totalCapacity : null,
        demand: null,
        actual: null,
        state: p.status === 'notConfigured' ? 'notInstalled' : p.status === 'notOperational' ? 'closed' : p.totalCapacity <= 0 ? 'zeroCapacity' : 'operational',
        basis: category === 'lounge'
          ? '5-19 集約 profile（terminal/serviceProfile.ts）。ラウンジ能力は席数（props.seats）合計。需要・実績は profile の範囲外のため未算出'
          : '5-19 集約 profile（terminal/serviceProfile.ts）。能力は areaServerCount 合計。需要・実績は profile の範囲外のため未算出',
      });
    }
  }
  return out;
}

/**
 * 夜間滞泊能力（F6-11）: 既存の overnightCapacity / overnightRequired を共通契約へ写す。
 * サイズ別の値は「そのサイズだけを置いた場合の最大機数」で、大きいスポットは小さい機にも
 * 使えるため合算できない。その旨を basis に明記する。
 */
export function overnightReadings(company: CompanyState, ctx: SimContext, day: number): CapabilityReading[] {
  const cap = overnightCapacity(ctx);
  const req = overnightRequired(company, ctx, day);
  return (['S', 'M', 'L'] as SizeClass3[]).map((size) => ({
    domain: 'night',
    subjectId: `overnight:${size}`,
    label: `夜間滞泊（${size} クラス）`,
    unit: 'aircraft',
    theoretical: cap[size],
    effective: cap[size],
    demand: req[size] ?? 0,
    actual: null,
    state: cap[size] <= 0 && (req[size] ?? 0) > 0 ? ('zeroCapacity' as const) : ('operational' as const),
    basis: '滞泊可能スポット数（economy/capacity.ts。大きいスポットは小さい機にも使えるためサイズ別の最大値で、合算不可）',
  }));
}

/**
 * 夜間整備枠（F6-11）: 1 晩あたり整備できる機数。sim/overnight.ts の
 * maintenanceCapacityPerNight と同じ式（格納庫 1 棟 = 1 機、整備施設はベイ × 0.5 の切り捨て。
 * 端数の繰り越し maintenanceCredit は含まない条件判定用の値）。
 */
export function maintenanceReading(layout: AirportLayout): CapabilityReading {
  let n = 0;
  for (const f of Object.values(layout.facilities)) {
    if (f.buildState !== 'operational') continue;
    if (f.kind === 'hangar') n += 1;
    else if (f.kind === 'maintenance') n += Math.floor(Number(f.props.bays ?? 0) * 0.5);
  }
  return {
    domain: 'maintenance',
    subjectId: 'maintenance:perNight',
    label: '夜間整備枠（1 晩あたり）',
    unit: 'aircraft/night',
    theoretical: n,
    effective: n,
    demand: null,
    actual: null,
    state: n <= 0 ? 'notInstalled' : 'operational',
    basis: '格納庫 1 棟 = 1 機 + 整備施設ベイ × 0.5（sim/overnight.ts maintenanceCapacityPerNight と同じ式）',
  };
}

/**
 * 運航中の状態（F6-04 残件、2026-11-19）: 有効な障害（sim/disruptions）と
 * 閉鎖理由台帳（sim/closureState）、滑走路モード、設備故障台帳
 * （sim/baggage の state.equipment）から closed / failed /
 * resourceShortage 状態の読み取りを生成する。減額源は既存の正本だけを使い、
 * 能力値は正本（facilityCapability）がある場合のみ写す（推定で埋めない）。
 * supplyShortage は F6-13（供給インフラ、保留中）の領域なので生成しない。
 * 表示への統合は composeCapabilityReadings（本ファイル）が正本の合成規則
 * （同じ subjectId では本関数の生成が優先）。
 * 設備故障台帳の生成（2026-11-20 追加）: 障害に由来しない停止
 * （sim/ground のランダム故障、運航画面からの手動停止）も failed として拾う。
 * 障害由来の分は障害側の生成が優先され、二重には出さない。`belt:` キー
 * （受取所ベルト）と車両・作業員ユニットのキーは施設を主体とする行の
 * 対象外とする（旧 UI 側導出と同じ範囲。ユニットの障害由来分は障害側で生成）。
 * 本関数は読み取り専用の導出で、運航状態の変更・乱数消費はしない。
 */
export function operationalStateReadings(state: SimState, layout: AirportLayout): CapabilityReading[] {
  const out: CapabilityReading[] = [];
  const emitted = new Set<string>();
  const nameOf = (id: string): string =>
    layout.runways[id]?.name ?? layout.facilities[id]?.name ?? layout.terminalAreas[id]?.name ?? layout.stands[id]?.name ?? id;
  const push = (r: CapabilityReading): void => {
    if (emitted.has(r.subjectId)) return;
    emitted.add(r.subjectId);
    out.push(r);
  };
  const assetReading = (subjectId: string, domain: string, st: CapabilityState, basis: string): CapabilityReading => {
    const f = layout.facilities[subjectId];
    if (f) {
      const base = facilityCapability(f);
      return { ...base, state: st, effective: base.theoretical !== null ? 0 : null, basis: `${base.basis}。${basis}` };
    }
    return { domain, subjectId, label: nameOf(subjectId), unit: '', theoretical: null, effective: 0, demand: null, actual: null, state: st, basis };
  };

  for (const d of state.disruptions) {
    if (d.status !== 'active') continue;
    switch (d.kind) {
      case 'runwayClosed':
        if (d.targetId) push(assetReading(d.targetId, 'airside', 'closed', `障害 ${d.id}（滑走路の一時閉鎖、sim/disruptions）`));
        break;
      case 'taxiwayClosed':
        if (d.targetId) push(assetReading(d.targetId, 'airside', 'closed', `障害 ${d.id}（誘導路の使用不能、sim/disruptions）`));
        break;
      case 'standClosed':
        if (d.targetId) push(assetReading(d.targetId, 'airside', 'closed', `障害 ${d.id}（スポットの使用不能、sim/disruptions）`));
        break;
      case 'gateFailure':
        if (d.targetId) push(assetReading(d.targetId, 'facility', 'failed', `障害 ${d.id}（搭乗ゲートの故障、sim/disruptions）`));
        break;
      case 'baggageFailure':
        if (d.targetId) push({ domain: 'baggage', subjectId: d.targetId, label: nameOf(d.targetId), unit: '', theoretical: null, effective: 0, demand: null, actual: null, state: 'failed', basis: `障害 ${d.id}（手荷物設備の故障、sim/disruptions）` });
        break;
      case 'vehicleFailure':
        if (d.targetId) push({ domain: 'ground', subjectId: d.targetId, label: d.targetId, unit: '', theoretical: null, effective: 0, demand: null, actual: null, state: 'failed', basis: `障害 ${d.id}（地上支援車両の故障、sim/disruptions）` });
        break;
      case 'staffAbsence': {
        const n = d.affected.units.length || Math.round(d.amount ?? 0);
        push({ domain: 'airport', subjectId: 'staff:absence', label: '作業員の欠勤', unit: 'staff', theoretical: null, effective: null, demand: null, actual: null, state: 'resourceShortage', basis: `障害 ${d.id}（作業員 ${n} 人が使用不可、sim/disruptions の staffAbsence）` });
        break;
      }
      default:
        break; // 天候・需要急増・到着遅延・整備は資産の状態ではないため対象外
    }
  }
  // 設備故障台帳（sim/baggage の state.equipment）: 停止中の設備のうち施設を
  // 主体とするものを failed として生成する。障害由来の分は上の障害ループで
  // 生成済み（push の重複排除で障害側の根拠が優先される）。
  // 理由の区別は repairUntil で行う: ランダム故障は自動復旧予定が入る
  // （sim/ground の randomFailures は repairSec を必ず指定する）ため
  // repairUntil あり、手動停止（editor/simRunner 経由）は repairSec を
  // 指定しないため repairUntil が null のままになる。
  for (const [key, eq] of Object.entries(state.equipment ?? {})) {
    if (!eq.broken) continue;
    if (key.startsWith('belt:')) continue; // 受取所ベルトは施設 ID ではない（旧 UI 導出でも対象外）
    if (!layout.facilities[key]) continue; // 車両・作業員ユニット等のキーは施設の行にしない
    push({
      domain: 'baggage', subjectId: key, label: nameOf(key), unit: '', theoretical: null, effective: 0, demand: null, actual: null, state: 'failed',
      basis: eq.repairUntil !== null
        ? '設備故障台帳（障害に由来しない故障で停止中、自動復旧予定あり。sim/ground のランダム故障 / sim/baggage の equipment）'
        : '設備故障台帳（運航画面で手動停止中、自動復旧なし。sim/baggage の equipment）',
    });
  }
  // 滑走路モード 'closed'（Work Order 実施中・障害）: 障害側で出した分は重ねない
  for (const r of Object.values(layout.runways)) {
    if (state.runwayConfig[r.id]?.mode === 'closed') {
      push(assetReading(r.id, 'airside', 'closed', '滑走路モードが closed（Work Order 実施中または障害、sim/workOrders・sim/disruptions）'));
    }
  }
  // 閉鎖理由台帳（Work Order・手動閉鎖など、障害以外の理由も含む）
  const kindDomain: Record<'taxiways' | 'stands' | 'gates', string> = { taxiways: 'airside', stands: 'airside', gates: 'facility' };
  for (const kind of ['taxiways', 'stands', 'gates'] as const) {
    for (const id of state.closures[kind]) {
      if (emitted.has(id)) continue;
      const reasons = closureReasonsFor(state, kind, id);
      const failed = reasons.some((reason) => {
        const d = state.disruptions.find((x) => `disruption:${x.id}` === reason);
        return d?.kind === 'gateFailure';
      });
      push(assetReading(id, kindDomain[kind], failed ? 'failed' : 'closed', `閉鎖理由台帳（${reasons.join(', ') || '理由未記録'}、sim/closureState）`));
    }
  }
  return out;
}
