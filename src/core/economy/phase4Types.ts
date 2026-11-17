import type { AircraftTypeId } from '../sim/aircraftTypes';

/**
 * フェーズ 4 の共通の型（docs/design/impl_phase4_plan.md §1 C0）。
 * すべて任意項目で、値がないデータは従来どおり動く。
 */

/** 日付をまたいでスポットに残る機体の記録（夜間滞泊・拠点・2-12 の夜間スポット待機） */
export interface CarryOverAircraft {
  sourceAircraftId: string;
  typeId: AircraftTypeId;
  airlineId: string | null;
  contractId: string | null;
  destinationId: string | null;
  callsign: string;
  depNumber: number;
  standId: string;
  /** 記録した時点で、そのスポットに着いてからの秒数 */
  parkedBeforeSec: number;
  /** 翌日の出発予定（0:00 からの秒、0〜86400 未満） */
  depSecOfDay: number;
  /** 出発の遅れ見込み（秒） */
  depDelaySec: number;
  /** 計画旅客数（出発便）。記録できない場合は null */
  depPax: number | null;
  seats?: number;
  basedAircraftId?: string;
  routeType?: 'international';
  /** 整備の不具合による出発の保留（秒） */
  techDelaySec?: number;
  /** 整備の不具合による欠航 */
  techCancel?: true;
}

/** 拠点契約の所属機 */
export interface BasedAircraft {
  id: string;
  airlineId: string;
  contractId: string;
  typeId: AircraftTypeId;
  /** 前回の整備からの運航回数 */
  cycles: number;
  lastCheckDay: number | null;
}

/** 乗継の波（バンク）の時間帯（分、0〜1440） */
export interface BankWindow {
  id: string;
  arriveFromMin: number;
  arriveToMin: number;
  departFromMin: number;
  departToMin: number;
}

export interface HubSettings {
  banks: BankWindow[];
  /** 乗継の上限（分） */
  maxConnectMin: number;
}

/** 乗継の種類: 国内→国内 / 国内→国際 / 国際→国内 / 国際→国際 */
export type TransferKind = 'DD' | 'DI' | 'ID' | 'II';
