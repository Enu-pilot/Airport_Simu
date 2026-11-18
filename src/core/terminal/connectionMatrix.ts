import { analyzeAccess, type AccessAnalysis, type AccessMode } from '../access/model';
import { sortedValues } from '../model/ids';
import type { AirportLayout, Facility } from '../model/types';
import { verifyPortalAccess, type FacilityConnectionStatus } from './networkGraph';

/**
 * 対外交通の接続マトリクス（5-18 の検証側）。
 *
 * 交通施設ごとに「外部（敷地外の道路・鉄道）への接続」と「ターミナル入口/出口への接続」を
 * 方向別に並べる。外部側はアクセス解析（analyzeAccess）の手段別利用可否を使い、
 * ターミナル側は Portal の到達性検証（verifyPortalAccess）の 3 状態を使う。
 * Portal を持たない施設は徒歩距離で判定される従来経路のため 'noPortal' と明示する。
 */
export const MATRIX_FACILITY_KINDS: readonly Facility['kind'][] = ['railStation', 'busTerminal', 'busStop', 'taxiStand', 'parking'];

export const FACILITY_MODE: Partial<Record<Facility['kind'], AccessMode>> = {
  parking: 'car',
  taxiStand: 'taxi',
  busStop: 'bus',
  busTerminal: 'bus',
  railStation: 'rail',
};

export type OutsideStatus = 'connected' | 'notOperational' | 'unavailable';

export interface ConnectionMatrixRow {
  facilityId: string;
  kind: Facility['kind'];
  mode: AccessMode | null;
  /** 外部への接続: その施設が手段として実際に使えるか */
  outside: OutsideStatus;
  /** 使えない理由（outside === 'unavailable' のとき。analyzeAccess の理由コード） */
  outsideReason: string | null;
  /** ターミナル側: 施設 → 入口（空港へ来る旅客の方向）。Portal がなければ 'noPortal' */
  toEntrance: FacilityConnectionStatus | 'noPortal';
  /** ターミナル側: 出口 → 施設（空港から帰る旅客の方向） */
  fromExit: FacilityConnectionStatus | 'noPortal';
}

export function connectionMatrix(layout: AirportLayout, access: AccessAnalysis = analyzeAccess(layout)): ConnectionMatrixRow[] {
  const portalStatus = new Map(verifyPortalAccess(layout).map((s) => [s.facilityId, s]));
  const rows: ConnectionMatrixRow[] = [];
  for (const f of sortedValues(layout.facilities)) {
    if (!MATRIX_FACILITY_KINDS.includes(f.kind)) continue;
    const mode = FACILITY_MODE[f.kind] ?? null;
    let outside: OutsideStatus = 'unavailable';
    let outsideReason: string | null = null;
    if (f.buildState !== 'operational') {
      outside = 'notOperational';
    } else if (mode && access.modes[mode].facilities.includes(f.id)) {
      outside = 'connected';
    } else if (mode) {
      outsideReason = access.modes[mode].reason ?? 'notConnected';
    }
    const ps = portalStatus.get(f.id);
    rows.push({
      facilityId: f.id,
      kind: f.kind,
      mode,
      outside,
      outsideReason,
      toEntrance: ps ? ps.toEntrance : 'noPortal',
      fromExit: ps ? ps.fromExit : 'noPortal',
    });
  }
  return rows;
}
