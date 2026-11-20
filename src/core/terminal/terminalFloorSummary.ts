import type { AirportLayout, TerminalAreaKind } from '../model/types';
import { areaProcessingPerHour } from './capacity';

/**
 * ターミナル設計 Workspace 用のフロア別集計（5-18 T5 の核）: 1 つのターミナルについて、
 * 階（建物内階。0 = 1F、負数 = 地下）ごとにエリア種別の件数・処理能力・席数を集計する。
 *
 * layout から決定的に導出される派生データで、保存形式には含めない
 * （serviceProfile と同じ流儀。編集のたびに layout が新しいオブジェクトになるため、
 * 呼び出し側は再計算してよい）。
 */
export interface TerminalFloorSummary {
  /** 建物内階（0 = 1F、-1 = B1） */
  level: number;
  /** エリア種別ごとの件数 */
  areas: Partial<Record<TerminalAreaKind, number>>;
  /** 処理能力があるエリアの種別別合計（人/時）。能力 0 の種別は含めない */
  processingPerHour: Partial<Record<TerminalAreaKind, number>>;
  /** 待合・出発ロビー・ラウンジの seats 合計 */
  seats: number;
}

/** 席数を数える種別（props.seats を持つ滞在系エリア） */
const SEAT_KINDS: ReadonlySet<TerminalAreaKind> = new Set(['waiting', 'departureLobby', 'lounge']);

export function terminalFloorSummary(layout: AirportLayout, terminalId: string): TerminalFloorSummary[] {
  const byLevel = new Map<number, TerminalFloorSummary>();
  for (const area of Object.values(layout.terminalAreas)) {
    if (area.terminalId !== terminalId) continue;
    let row = byLevel.get(area.level);
    if (!row) {
      row = { level: area.level, areas: {}, processingPerHour: {}, seats: 0 };
      byLevel.set(area.level, row);
    }
    row.areas[area.kind] = (row.areas[area.kind] ?? 0) + 1;
    const perHour = areaProcessingPerHour(area.kind, area.props);
    if (perHour > 0) row.processingPerHour[area.kind] = (row.processingPerHour[area.kind] ?? 0) + perHour;
    if (SEAT_KINDS.has(area.kind)) {
      const seats = Number(area.props.seats);
      if (Number.isFinite(seats) && seats > 0) row.seats += seats;
    }
  }
  return [...byLevel.values()].sort((a, b) => a.level - b.level);
}
