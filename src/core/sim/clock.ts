/**
 * 描画フレームとゲーム内時間の分離。
 *
 * フレームごとの実時間経過に時間倍率を掛けてティック数に換算する。ティックの刻み幅は常に一定（1ゲーム秒）で、
 * 倍率が変えるのは「1フレームで何ティック進めるか」だけなので、倍率を上げても移動量の判定は変わらない。
 * 処理が追いつかない場合は 1 フレームあたりのティック数を上限で打ち切り、積み残しは捨てる
 * （ゲーム内時間が遅れるだけで、機体がワープしない）。
 */
export interface SimClock {
  /** 実時間1秒あたりのゲーム内秒数。0 は一時停止 */
  speed: number;
  /** 端数（次のティックまでの進み具合、0..1） */
  acc: number;
}

export const SPEED_LEVELS = [
  { speed: 0, label: '一時停止' },
  { speed: 1, label: '実時間' },
  { speed: 15, label: '×15' },
  { speed: 60, label: '×60' },
  { speed: 240, label: '×240' },
  { speed: 600, label: '×600' },
] as const;

/** 1フレームの実時間がこれを超えたら（タブ非表示からの復帰など）切り詰める */
export const MAX_FRAME_SEC = 0.25;
export const DEFAULT_MAX_TICKS_PER_FRAME = 120;

export function createClock(speed = 60): SimClock {
  return { speed, acc: 0 };
}

export function advanceClock(
  clock: SimClock,
  realDtSec: number,
  maxTicks = DEFAULT_MAX_TICKS_PER_FRAME,
): { ticks: number; clock: SimClock; dropped: boolean } {
  if (clock.speed <= 0 || realDtSec <= 0) return { ticks: 0, clock, dropped: false };
  const acc = clock.acc + Math.min(realDtSec, MAX_FRAME_SEC) * clock.speed;
  const ticks = Math.floor(acc);
  if (ticks > maxTicks) return { ticks: maxTicks, clock: { ...clock, acc: 0 }, dropped: true };
  return { ticks, clock: { ...clock, acc: acc - ticks }, dropped: false };
}
