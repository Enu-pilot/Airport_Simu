import { CHECKIN_SHARE, PAX_PROCESS_LEAD_SEC, type DayPlan, type PlannedFlight } from './planning';

/**
 * 運行計画から算出するピーク需要（5-21 の最混雑 60 分の考え方を表示用に切り出したもの）。
 *
 * 定義（計画分析 analyzeDayPlan の時間帯需要と同じ前提）:
 * - 出発旅客は「出発の PAX_PROCESS_LEAD_SEC（90 分）前に手続きに現れる」ものとして、
 *   その出現時刻を起点に任意の 60 分窓へ入る人数の最大をピーク需要（人/時）とする。
 * - チェックイン需要は出発ピーク × CHECKIN_SHARE（能力照合で使う利用率と同じ）。
 * - 到着旅客は到着時刻（+ 計画上の到着遅延）に現れるものとして同じ 60 分窓で数える。
 * 表示専用の集計で、運航判定には使わない。
 */
export interface ProcessPeakDemand {
  /** 出発手続きのピーク需要（人/時） */
  departurePaxPerHour: number;
  /** チェックインのピーク需要（人/時）= 出発ピーク × CHECKIN_SHARE */
  checkInPaxPerHour: number;
  /** 到着側のピーク需要（人/時） */
  arrivalPaxPerHour: number;
}

/** 任意の 60 分窓に入る人数の最大（窓は [t, t+3600) ） */
export function peakWindowPerHour(events: readonly { at: number; pax: number }[]): number {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  let best = 0;
  let sum = 0;
  let j = 0;
  for (let i = 0; i < sorted.length; i++) {
    sum += sorted[i]!.pax;
    while (sorted[i]!.at - sorted[j]!.at >= 3600) {
      sum -= sorted[j]!.pax;
      j++;
    }
    if (sum > best) best = sum;
  }
  return best;
}

export function peakProcessDemand(
  plan: DayPlan,
  opts: {
    /** 指定時はそのターミナルに割り当てられた便だけを数える */
    terminalId?: string;
    /** 便 → ターミナルの割当（analyzeDayPlan の assignments 由来） */
    terminalIdOf?: (flight: PlannedFlight) => string | null | undefined;
    /** ターミナルが 1 つだけの空港では、未割当の便もそのターミナルとして数える（計画分析の fallback と同じ） */
    soleTerminalId?: string;
  } = {},
): ProcessPeakDemand {
  const flights = opts.terminalId === undefined
    ? plan.flights
    : plan.flights.filter((f) => (opts.terminalIdOf?.(f) ?? opts.soleTerminalId) === opts.terminalId);
  const departure = peakWindowPerHour(flights.map((f) => ({ at: f.departureAt - PAX_PROCESS_LEAD_SEC, pax: f.depPax })));
  const arrival = peakWindowPerHour(flights.map((f) => ({ at: f.arrivalAt + f.inboundDelaySec, pax: f.arrPax })));
  return {
    departurePaxPerHour: departure,
    checkInPaxPerHour: Math.round(departure * CHECKIN_SHARE),
    arrivalPaxPerHour: arrival,
  };
}
