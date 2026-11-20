import type { AirportLayout, SizeClass } from '../model/types';
import type { DailyReport } from '../economy/company';
import { buildTerminalModel } from './model';
import { areaProcessingPerHour } from './capacity';

/**
 * ターミナル別の容量サマリ（表示用）: 所属スポット数と保安検査の処理能力・使用率。
 * 航空会社の使用ターミナルを選ぶときに「そのターミナルにどれだけ余裕があるか」を
 * 判断するための読み取り専用集計で、割当ロジックには影響しない。
 */
export interface TerminalCapacitySummary {
  terminalId: string;
  /** 運用中スポットの数（ゲート所属＋リモートスポットの明示所属） */
  stands: number;
  standsBySize: Record<SizeClass, number>;
  /** 保安検査エリアの処理能力合計（人/時）。保安エリアがなければ 0 */
  securityPerHour: number;
  /** 直近の日報の保安検査ピーク使用率（0〜1）。日報が無い/記録が無ければ null */
  securityUtilization: number | null;
}

export function terminalCapacitySummaries(
  layout: AirportLayout,
  latestReport?: DailyReport | null,
): Map<string, TerminalCapacitySummary> {
  const model = buildTerminalModel(layout);
  const byTerminal = new Map<string, TerminalCapacitySummary>();
  const ensure = (terminalId: string): TerminalCapacitySummary => {
    let s = byTerminal.get(terminalId);
    if (!s) {
      s = {
        terminalId,
        stands: 0,
        standsBySize: { S: 0, M: 0, L: 0 },
        securityPerHour: 0,
        securityUtilization: null,
      };
      byTerminal.set(terminalId, s);
    }
    return s;
  };
  for (const f of Object.values(layout.facilities)) {
    if (f.kind === 'terminal') ensure(f.id);
  }

  // スポット所属: コンタクトはゲートの所属、リモートは Stand.terminalId の明示指定
  const counted = new Set<string>();
  const countStand = (terminalId: string | null, standId: string) => {
    if (!terminalId || counted.has(standId)) return;
    const stand = layout.stands[standId];
    if (!stand || stand.buildState !== 'operational') return;
    counted.add(standId);
    const s = ensure(terminalId);
    s.stands += 1;
    s.standsBySize[stand.size] += 1;
  };
  for (const [gateId, access] of Object.entries(model.gates)) {
    const standId = layout.facilities[gateId]?.props.standId;
    if (typeof standId === 'string') countStand(access.terminalId, standId);
  }
  for (const stand of Object.values(layout.stands)) {
    if (stand.terminalId) countStand(stand.terminalId, stand.id);
  }

  // 保安検査の処理能力（エリア props からの理論値）
  for (const area of Object.values(layout.terminalAreas)) {
    if (area.kind !== 'security') continue;
    ensure(area.terminalId).securityPerHour += areaProcessingPerHour('security', area.props);
  }

  // 使用率は直近の日報の工程ピーク（ターミナル別）から
  if (latestReport?.processPeakByTerminal) {
    for (const row of latestReport.processPeakByTerminal) {
      if (row.step !== 'security') continue;
      ensure(row.terminalId).securityUtilization = row.utilization;
    }
  }
  return byTerminal;
}
