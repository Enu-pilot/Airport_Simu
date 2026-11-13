/**
 * ランプバス（バス搭乗）の規則値（すべてゲーム値。実在の運用基準ではない）。docs/29_remote_stands_and_bus_boarding.md
 */

/** バス扱いの便の搭乗開始を早める時間（分）。バスの移動・乗降の分 */
export const BUS_EXTRA_LEAD_MIN = 10;
/** バス扱いの便の搭乗開始から締切までの最低時間（秒） */
export const BUS_MIN_WINDOW_SEC = 20 * 60;
/** バスゲートの搭乗券の確認（秒/人） */
export const BUS_GATE_SEC_PER_PAX = 2;
/** ゲート締切後、バスが来ない旅客を乗り遅れ（noBus）にするまでの時間（秒） */
export const BUS_GIVEUP_SEC = 15 * 60;
/** ランプバスの定員（人）。グループ（1〜5 人）は分割しない */
export const APRON_BUS_CAPACITY = 60;
/** ドアの開閉（秒）、乗車の速さ（秒/人）、乗車待ちの最長（秒、1 人以上乗っているとき） */
export const BUS_DOOR_SEC = 60;
export const BUS_LOAD_SEC_PER_PAX = 1;
export const BUS_MAX_LOAD_SEC = 300;
/** 降車（秒/人）: 出発 = バスを降りてタラップで機内へ、到着 = 降りるだけ */
export const BUS_UNLOAD_SEC_PER_PAX = { dep: 2.5, arr: 1 } as const;
/** 救援のバスへの乗り換え時間（秒）= ドアの開閉 × 2 */
export const BUS_TRANSFER_SEC = BUS_DOOR_SEC * 2;
/** 「ランプバス不足」のアラートを出すまで運行が配車待ちで続いた時間（秒） */
export const BUS_SHORTAGE_ALERT_SEC = 3 * 60;
