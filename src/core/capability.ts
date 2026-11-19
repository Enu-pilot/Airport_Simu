import type { AirportLayout, Facility } from './model/types';
import { overnightCapacity, overnightRequired, type CapacityMetric, type SizeClass3 } from './economy/capacity';
import type { CompanyState, DailyReport } from './economy/company';
import type { SimContext } from './sim/context';
import { BALANCE } from './economy/balance';
import { towerCapacityPerHour } from './safety';
import { verifyPortalAccess } from './terminal/networkGraph';

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
 * 施設 1 件の能力（F6-02 インスペクターの正本）。
 * 能力式が定義されている種別だけ理論能力を返し、それ以外は未算出として理由を返す。
 * 有効能力は稼働状態のみを反映する（接続・人員・供給の減額源が無い種別では理論と同値）。
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
        uncomputedReason: 'この施設種別には能力式が定義されていない',
        basis: 'Phase 6 計画 §4.1: 根拠のない能力は推定で埋めない',
      };
  }
}

/** レイアウト内の全施設の能力（未算出の施設も状態として含む）。ポータル接続の到達性も減額源として反映する */
export function layoutCapabilities(layout: AirportLayout): CapabilityReading[] {
  const portal = new Map(verifyPortalAccess(layout).map((s) => [s.facilityId, s]));
  return Object.values(layout.facilities).map((f) => {
    const s = portal.get(f.id);
    const portalUnreachable = s !== undefined && (s.toEntrance === 'unreachable' || s.fromExit === 'unreachable');
    return facilityCapability(f, { portalUnreachable });
  });
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
