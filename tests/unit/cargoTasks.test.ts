import { describe, expect, it } from 'vitest';
import { CARGO_TASKS, TASK_DEFS, TURNAROUND_TASKS, cargoTaskSec } from '../../src/core/sim/tasks';
import { TASK_LABEL } from '../../src/i18n/ja';

/**
 * 5-12 貨物タスクの土台: 手荷物タスクとは別種の cargoUnload / cargoLoad。
 * まだ便は生成しない（タスク定義と所要時間の計算だけ）。旅客の折り返し集合は不変。
 */
describe('5-12 貨物タスク定義', () => {
  it('貨物タスクは手荷物タスクと別種で、依存と必要ユニットを持つ', () => {
    expect(CARGO_TASKS).toEqual(['cargoUnload', 'cargoLoad']);
    expect(TASK_DEFS.cargoUnload.deps).toEqual([]);
    expect(TASK_DEFS.cargoLoad.deps).toEqual(['cargoUnload']);
    expect(TASK_DEFS.cargoUnload.needs).toEqual({ staff: 2 });
    expect(TASK_LABEL.cargoUnload).toBe('貨物荷下ろし');
    expect(TASK_LABEL.cargoLoad).toBe('貨物積み込み');
  });

  it('旅客の折り返しタスク集合は変わらない', () => {
    expect(TURNAROUND_TASKS).toEqual(['deplane', 'unload', 'fuel', 'clean', 'cater', 'inspect', 'board', 'load']);
  });

  it('所要時間は搭載量 ÷ 上屋能力。能力なし・少量の扱いも定義どおり', () => {
    expect(cargoTaskSec(60, 60)).toBe(3600);
    expect(cargoTaskSec(120, 60)).toBe(7200);
    expect(cargoTaskSec(0, 60)).toBe(0);
    expect(cargoTaskSec(10, 0)).toBe(1800); // 上屋なしでは扱えない前提の仮置き
    expect(cargoTaskSec(1, 60)).toBe(300); // 最低 300 秒
  });
});
