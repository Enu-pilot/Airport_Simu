import { describe, expect, it } from 'vitest';
import type { AirlineTerminalPolicy } from '../../src/core/economy/company';
import type { PlannedFlight } from '../../src/core/economy/planning';
import type { SizeClass } from '../../src/core/model/types';
import type { TerminalCapacitySummary } from '../../src/core/terminal/terminalCapacitySummary';
import { airlineTerminalSpotWarnings } from '../../src/core/terminal/terminalSpotWarnings';

/**
 * 使用ターミナル指定へのスポット容量警告: 計画便のピーク同時駐機数（按分）と
 * ターミナルのスポット数（サイズ別）を比べる表示専用の判定。
 * 型式は汎用機材 regional70 = S / narrow180 = M / wide300 = L を使う。
 */

const TYPE_BY_SIZE: Record<SizeClass, string> = { S: 'regional70', M: 'narrow180', L: 'wide300' };

function summary(terminalId: string, standsBySize: Partial<Record<SizeClass, number>>): TerminalCapacitySummary {
  const bySize: Record<SizeClass, number> = { S: standsBySize.S ?? 0, M: standsBySize.M ?? 0, L: standsBySize.L ?? 0 };
  return {
    terminalId,
    stands: bySize.S + bySize.M + bySize.L,
    standsBySize: bySize,
    securityPerHour: 0,
    securityUtilization: null,
  };
}

let seq = 0;
function flight(
  airlineId: string,
  size: SizeClass,
  fromMin: number,
  toMin: number,
  opts: { international?: boolean; dedicatedStandId?: string } = {},
): PlannedFlight {
  seq += 1;
  return {
    key: `f${seq}`,
    contractId: `k${seq}`,
    airlineId,
    destinationId: 'XXX',
    typeId: TYPE_BY_SIZE[size],
    arrNumber: `A${seq}`,
    depNumber: `A${seq + 1000}`,
    arrivalAt: fromMin * 60,
    departureAt: toMin * 60,
    arrPax: 0,
    depPax: 0,
    seats: 0,
    inboundDelaySec: 0,
    ...(opts.international ? { routeType: 'international' as const } : {}),
    ...(opts.dedicatedStandId ? { dedicatedStandId: opts.dedicatedStandId } : {}),
  };
}

/** 同時刻に n 機が重なるフライト列（10:00 到着・12:00 出発） */
function overlapping(airlineId: string, size: SizeClass, n: number): PlannedFlight[] {
  return Array.from({ length: n }, () => flight(airlineId, size, 600, 720));
}

function warningsFor(
  policies: Record<string, AirlineTerminalPolicy> | undefined,
  summaries: TerminalCapacitySummary[],
  flights: PlannedFlight[],
  prevOvernight: PlannedFlight[] = [],
) {
  return airlineTerminalSpotWarnings({
    summaries: new Map(summaries.map((s) => [s.terminalId, s])),
    policies,
    flights,
    prevOvernight,
  });
}

describe('使用ターミナルのスポット容量警告', () => {
  it('確定警告: 運航サイズ以上のスポットが許可ターミナルに無い', () => {
    const warnings = warningsFor(
      { AA: { domestic: ['t1'] } },
      [summary('t1', { S: 2 })],
      [flight('AA', 'L', 600, 720)],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ airlineId: 'AA', routeType: 'domestic', missingSizes: ['L'] });
    // スポット 0 件の逼迫は確定警告と重ねて出さない
    expect(warnings[0]!.pressures).toEqual([]);
  });

  it('確定警告は運航していないサイズには出ない（S 運航のみで L スポットだけでも警告なし）', () => {
    const warnings = warningsFor(
      { AA: { domestic: ['t1'] } },
      [summary('t1', { L: 2 })],
      [flight('AA', 'S', 600, 720)],
    );
    expect(warnings).toEqual([]);
  });

  it('逼迫警告（超過）: 単独指定でピーク需要がスポット数を超える', () => {
    const warnings = warningsFor(
      { AA: { domestic: ['t1'] } },
      [summary('t1', { M: 2 })],
      overlapping('AA', 'M', 3),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.missingSizes).toEqual([]);
    expect(warnings[0]!.pressures).toEqual([
      { terminalId: 't1', sizeAtLeast: 'M', demand: 3, capacity: 2, level: 'over' },
    ]);
  });

  it('逼迫警告（逼迫）: 需要が容量の9割以上で超過はしていない', () => {
    const warnings = warningsFor(
      { AA: { domestic: ['t1'] } },
      [summary('t1', { M: 10 })],
      overlapping('AA', 'M', 9),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.pressures).toEqual([
      { terminalId: 't1', sizeAtLeast: 'M', demand: 9, capacity: 10, level: 'tight' },
    ]);
  });

  it('需要が容量に余裕を持って収まれば警告なし', () => {
    const warnings = warningsFor(
      { AA: { domestic: ['t1'] } },
      [summary('t1', { M: 4 })],
      overlapping('AA', 'M', 2),
    );
    expect(warnings).toEqual([]);
  });

  it('制限なしの会社には、需要が大きくても警告が出ない', () => {
    const warnings = warningsFor(
      undefined,
      [summary('t1', { M: 1 })],
      overlapping('AA', 'M', 5),
    );
    expect(warnings).toEqual([]);
    // 別の会社だけ制限がある場合も、無制限の会社には出ない
    const warnings2 = warningsFor(
      { BB: { domestic: ['t1'] } },
      [summary('t1', { M: 1 })],
      overlapping('AA', 'M', 5),
    );
    expect(warnings2).toEqual([]);
  });

  it('複数会社が同じターミナルを指定すると、合計需要で逼迫する', () => {
    const flights = [...overlapping('AA', 'M', 2), ...overlapping('BB', 'M', 2)];
    const summaries = [summary('t1', { M: 3 })];
    // 単独では 2/3 で警告なし
    expect(warningsFor({ AA: { domestic: ['t1'] } }, summaries, flights.filter((f) => f.airlineId === 'AA'))).toEqual([]);
    const warnings = warningsFor({ AA: { domestic: ['t1'] }, BB: { domestic: ['t1'] } }, summaries, flights);
    expect(warnings.map((w) => w.airlineId).sort()).toEqual(['AA', 'BB']);
    for (const w of warnings) {
      expect(w.pressures).toEqual([{ terminalId: 't1', sizeAtLeast: 'M', demand: 4, capacity: 3, level: 'over' }]);
    }
  });

  it('複数ターミナル指定の需要は按分される（片方だけ逼迫）', () => {
    const warnings = warningsFor(
      { AA: { domestic: ['t1', 't2'] } },
      [summary('t1', { M: 2 }), summary('t2', { M: 10 })],
      overlapping('AA', 'M', 4),
    );
    expect(warnings).toHaveLength(1);
    // ピーク 4 機を 2 ターミナルへ按分 → t1 は需要 2 / 容量 2 で逼迫、t2 は余裕
    expect(warnings[0]!.pressures).toEqual([
      { terminalId: 't1', sizeAtLeast: 'M', demand: 2, capacity: 2, level: 'tight' },
    ]);
  });

  it('前日の夜間滞泊は朝のピークに数える', () => {
    const summaries = [summary('t1', { M: 2 })];
    const policies: Record<string, AirlineTerminalPolicy> = { AA: { domestic: ['t1'] } };
    const morning = [flight('AA', 'M', 390, 480)]; // 6:30 着・8:00 発（単独では需要 1 / 容量 2 で警告なし）
    expect(warningsFor(policies, summaries, morning)).toEqual([]);
    const overnight = flight('AA', 'M', 1200, 1440 + 420); // 前日着・当日 7:00 発
    const warnings = warningsFor(policies, summaries, morning, [overnight]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.pressures[0]).toMatchObject({ terminalId: 't1', level: 'tight', demand: 2, capacity: 2 });
  });

  it('専用スポット付きの便は需要にもサイズ判定にも入らない', () => {
    const warnings = warningsFor(
      { AA: { domestic: ['t1'] } },
      [summary('t1', { S: 1 })],
      [flight('AA', 'L', 600, 720, { dedicatedStandId: 'stand-x' })],
    );
    expect(warnings).toEqual([]);
  });

  it('国内線と国際線の指定は独立に判定される', () => {
    const warnings = warningsFor(
      { AA: { international: ['t1'] } },
      [summary('t1', { M: 2 })],
      [...overlapping('AA', 'M', 3), flight('AA', 'M', 600, 720, { international: true })],
    );
    // 国内線は無制限なので需要に数えない。国際線は 1 機だけなので逼迫なし
    expect(warnings).toEqual([]);
    const warnings2 = warningsFor(
      { AA: { international: ['t1'] } },
      [summary('t1', { M: 1 })],
      [flight('AA', 'M', 600, 720, { international: true }), flight('AA', 'M', 630, 720, { international: true })],
    );
    expect(warnings2).toHaveLength(1);
    expect(warnings2[0]).toMatchObject({ airlineId: 'AA', routeType: 'international' });
    expect(warnings2[0]!.pressures[0]).toMatchObject({ level: 'over', demand: 2, capacity: 1 });
  });

  it('大きいサイズのスポットは小さい機材の需要にも数える（累積判定）', () => {
    // M スポット 0・L スポット 2 でも M 機 2 機は L スポットに入れる
    const warnings = warningsFor(
      { AA: { domestic: ['t1'] } },
      [summary('t1', { L: 2 })],
      overlapping('AA', 'M', 2),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.missingSizes).toEqual([]);
    expect(warnings[0]!.pressures[0]).toMatchObject({ sizeAtLeast: 'M', demand: 2, capacity: 2, level: 'tight' });
  });
});
