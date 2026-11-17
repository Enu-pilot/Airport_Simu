import type { SizeClass } from '../model/types';

/**
 * 運航ルールの定数（ゲーム用の簡略化モデル。docs/11_operations_rules.md 参照）。
 * 実際の航空管制方式・離着陸間隔を再現するものではない。
 */

/** 1ティックのゲーム内秒数（固定）。時間倍率はティック数だけを変え、刻み幅は変えない */
export const TICK_SEC = 1;
export const DAY_SEC = 86400;
/** シミュレーション開始時刻（0日目 06:00） */
export const SIM_START_SEC = 6 * 3600;

/** 到着機が空域に現れる時刻（着陸予定の何秒前か） */
export const INBOUND_LEAD_SEC = 15 * 60;
/** 最終進入の所要時間（進入許可 → 滑走路端） */
export const APPROACH_SEC = 90;
/** 空中待機の上限。超えるとダイバート（運航不能） */
export const HOLD_DIVERT_SEC = 45 * 60;
/** 出発機が経路を得られない状態の上限。超えると欠航（運航不能） */
export const DEPARTURE_GIVE_UP_SEC = 60 * 60;
/** 経路・許可の再試行間隔 */
export const RETRY_SEC = 5;

/** 地上走行の加速度・減速度（m/s²） */
export const TAXI_ACCEL = 0.6;
export const TAXI_DECEL = 1.2;
/** 曲がり角（45度以上の方向転換）での速度上限 */
export const TURN_SPEED = 5;
/** スポット進入・プッシュバック・滑走路への整列の速度 */
export const STAND_SPEED = 2;
export const PUSHBACK_SPEED = 1.5;
export const LINEUP_SPEED = 4;
/** 着陸後の離脱速度 */
export const EXIT_SPEED = 15;
/** プッシュバック後のエンジン始動、滑走路上での整列にかかる時間 */
export const ENGINE_START_SEC = 60;
export const LINEUP_ALIGN_SEC = 15;
/** 出発後、表示から消えるまでの時間 */
export const DEPARTED_DESPAWN_SEC = 60;

/** 滑走路手前の停止位置（滑走路中心線からの距離、m）。保護区域の半幅に相当 */
export const HOLD_SHORT_M = 87.5;
/** 停止位置は接続エッジの長さのこの割合を超えない */
export const HOLD_SHORT_MAX_RATIO = 0.6;

/** 自由形の停止位置の角度補正で使う sinθ の下限（ゲーム値。sin 15°。浅い角度で停止位置が遠くなりすぎるのを防ぐ） */
export const SIN_MIN_HOLD = Math.sin((15 * Math.PI) / 180);

/** 同種運用（到着→到着、出発→出発）の最小間隔（秒）[先行機][後続機] */
export const SEPARATION_SEC: Record<SizeClass, Record<SizeClass, number>> = {
  S: { S: 60, M: 60, L: 60 },
  M: { S: 90, M: 75, L: 75 },
  L: { S: 120, M: 120, L: 90 },
};
/** 出発機の滑走開始から、次の到着機が滑走路端に来るまでの最小間隔 */
export const ARRIVAL_AFTER_DEPARTURE_SEC = 45;
/** 進入中の到着機がいるとき、出発・横断に必要な余裕（到着予定までの秒数） */
export const DEPARTURE_WINDOW_SEC = 90;
export const CROSSING_WINDOW_SEC = 60;
/** 離陸待ちがこの時間を超えたら、新しい進入許可を止めて出発を優先する（飢餓防止） */
export const DEPARTURE_STARVATION_SEC = 10 * 60;

/** 経路探索: 滑走路を横断する経路に加えるコスト（秒） */
export const CROSSING_PENALTY_SEC = 120;

/** 地上で動いている2機の最小距離（m）。これ未満は競合として記録する */
export const MIN_GROUND_SEPARATION_M = 20;

// ---------------------------------------------------------------- 区間ごとに進む地上走行（フェーズ 2、taxiMode 'block'）

/** 追従時の機首〜前機の尾部の間隔（m）。MIN_GROUND_SEPARATION_M の 2 倍 */
export const FOLLOW_GAP_M = 40;
/** 区間内で 1 機が必要とする長さ（m）= 区分内の最大機体長 + FOLLOW_GAP_M を 10 m 単位に切り上げ。ゲーム内の値 */
export const BLOCK_REQ_M: Record<SizeClass, number> = { S: 70, M: 90, L: 120 };
/** 交差点・スポット入口の手前で止まる距離（m） */
export const JUNCTION_STOP_M = 45;
/** 確保を要求する距離: 停止位置までが「制動距離 + この値」未満になったら要求する（m） */
export const BLOCK_REQUEST_AHEAD_M = 50;
/** 逆向きを待つ機体がこの時間以上待ったら、同じ向きの新しい確保を止める（公平性。秒） */
export const DIR_FAIRNESS_SEC = 120;
/** 規則 4（停止の検出）: この時間以上待ったら閉路を探す / 待機機の経路の選び直しの間隔（秒） */
export const STALL_SEC = 180;
export const REROUTE_SEC = 60;
/** 夜間: 予測離陸の余裕（秒） */
export const NIGHT_DEP_MARGIN_SEC = 600;
