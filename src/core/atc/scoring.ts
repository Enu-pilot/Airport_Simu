import type { AtcRequestKind, AtcSessionState } from './types';
import { ATC_MODEL_VERSION } from './types';

/**
 * ATC-09: 評価レポート。
 * セッション状態とイベント列から決定的に導出する読み取り専用レポートであり、
 * 新しいシミュレーション状態は持たない。同じセッション状態からは常に
 * 同じレポートが得られ、集計値は session.score（ダイジェスト対象）と矛盾しない。
 *
 * 安全評価と処理能力評価の分離（計画 §5 ATC-09 受入条件・§9-7）:
 * - 安全側はハード評価とする。安全拒否・期限切れ・取消・実行前失効・復行は
 *   独立した `safety` 節に件数と段階評価（rating）だけを置き、処理能力の
 *   数値スコアには一切混ぜない（発着数で安全イベントを相殺しない）。
 * - 処理能力側は `throughput` 節で数値スコア化する。安全イベントは
 *   throughput.score の計算式には現れない。
 * - 総合グレード（overall.grade）は throughput スコアから決めるが、
 *   安全 rating が悪い場合は上限（キャップ）を掛ける。これは相殺ではなく
 *   頭打ちであり、スコア自体は書き換えない（cappedBySafety で明示する）。
 * - 経営モードの収支・航空会社満足度・空港格へは数値を流さない（ATC内で閉じる）。
 */

/** 安全側の段階評価。数値スコアとは独立したハード評価 */
export type AtcSafetyRating =
  | 'clean' // 安全関連イベントなし
  | 'events' // 期限切れ・取消・失効・復行はあるが、安全拒否はない
  | 'denials'; // 安全判定で拒否された指示がある

export interface AtcSafetyReport {
  /** 安全判定で拒否した指示の件数（session.score.safetyDenials と一致） */
  safetyDenials: number;
  /** 復行した回数（航空機の goAroundCount の合計） */
  goArounds: number;
  /** 有効期限切れになった指示の件数（session.score.clearancesExpired と一致） */
  clearancesExpired: number;
  /** 取消された指示の件数（復行による取消を含む。clearances の状態から導出） */
  clearancesCancelled: number;
  /** 実行直前の再検証で失効した指示の件数（safetyWarning イベントから導出） */
  revokedBeforeExecution: number;
  /** 安全警告イベントの総数 */
  safetyWarnings: number;
  /** 管制官が却下（待機指示）した要求の件数（session.score.requestsRejected と一致） */
  requestsRejected: number;
  rating: AtcSafetyRating;
}

export interface AtcHourlyBucket {
  /** セッション開始からの時間帯インデックス（0 = 最初の1時間） */
  hourIndex: number;
  startSec: number;
  arrivalsHandled: number;
  departuresHandled: number;
  clearancesIssued: number;
}

export interface AtcResponseStats {
  /** 応答時間を測れた要求の件数（許可が発行された要求） */
  count: number;
  avgSec: number;
  maxSec: number;
}

export interface AtcThroughputReport {
  arrivalsHandled: number;
  departuresHandled: number;
  aircraftHandled: number;
  /** 出現済み航空機数（処理率の分母） */
  aircraftSpawned: number;
  /** 処理率 = aircraftHandled / aircraftSpawned（出現0機なら0） */
  completionRatio: number;
  clearancesIssued: number;
  /** 指示種別ごとの発行数 */
  clearancesByKind: Partial<Record<AtcRequestKind, number>>;
  /** 累積待機秒（session.score.totalWaitSec と一致） */
  totalWaitSec: number;
  /** 処理済み航空機1機あたりの平均待機秒（未処理のみの場合は0） */
  avgWaitSecPerHandled: number;
  /** 処理済み航空機の最大待機秒（未処理のみの場合は0） */
  maxWaitSec: number;
  /** 要求発生から許可発行までの応答時間 */
  response: AtcResponseStats;
  /** 時間帯別の処理量（活動があった最後の時間帯まで） */
  hourly: AtcHourlyBucket[];
  /** 1時間あたり指示発行数の最大（管制負荷のピーク） */
  peakHourlyClearances: number;
  /** 処理能力スコア（0-100。安全イベントは含まない） */
  score: number;
}

export type AtcOverallGrade = 'S' | 'A' | 'B' | 'C' | 'D';

export interface AtcReport {
  modelVersion: string;
  scenarioId: string;
  clockSec: number;
  finished: boolean;
  safety: AtcSafetyReport;
  throughput: AtcThroughputReport;
  overall: {
    grade: AtcOverallGrade;
    /** throughput.score の写し（安全で書き換えない） */
    throughputScore: number;
    safetyRating: AtcSafetyRating;
    /** 安全 rating による頭打ちが実際に効いたか */
    cappedBySafety: boolean;
  };
}

const GRADE_ORDER: AtcOverallGrade[] = ['D', 'C', 'B', 'A', 'S'];

/** スコアからグレードを決める（ゲーム値。根拠は buildAtcReport の式に同じ） */
function gradeForScore(score: number): AtcOverallGrade {
  if (score >= 90) return 'S';
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

/** 安全 rating による総合グレードの上限（相殺ではなく頭打ち） */
const SAFETY_GRADE_CAP: Record<AtcSafetyRating, AtcOverallGrade> = {
  clean: 'S',
  events: 'A',
  denials: 'C',
};

const REQUEST_KINDS: AtcRequestKind[] = [
  'landing',
  'taxiIn',
  'pushback',
  'taxiOut',
  'runwayCrossing',
  'lineUp',
  'takeoff',
];

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export function buildAtcReport(session: AtcSessionState): AtcReport {
  const aircraft = Object.values(session.aircraft).sort((a, b) => (a.id < b.id ? -1 : 1));
  const clearances = Object.values(session.clearances).sort((a, b) => a.seq - b.seq);
  const completed = aircraft.filter((a) => a.completedAtSec !== null);

  // --- 安全側（ハード評価。処理能力の数値とは混ぜない） ---
  const goArounds = aircraft.reduce((sum, a) => sum + (a.goAroundCount ?? 0), 0);
  const clearancesCancelled = clearances.filter((c) => c.status === 'cancelled').length;
  const safetyWarningEvents = session.events.filter((e) => e.kind === 'safetyWarning');
  const revokedBeforeExecution = safetyWarningEvents.filter((e) =>
    e.message.includes('revoked before execution'),
  ).length;
  const safety: AtcSafetyReport = {
    safetyDenials: session.score.safetyDenials,
    goArounds,
    clearancesExpired: session.score.clearancesExpired,
    clearancesCancelled,
    revokedBeforeExecution,
    safetyWarnings: safetyWarningEvents.length,
    requestsRejected: session.score.requestsRejected,
    rating:
      session.score.safetyDenials > 0
        ? 'denials'
        : goArounds + session.score.clearancesExpired + clearancesCancelled + revokedBeforeExecution > 0
          ? 'events'
          : 'clean',
  };

  // --- 処理能力側（数値評価。安全イベントは計算式に現れない） ---
  const arrivalsHandled = session.score.arrivalsHandled;
  const departuresHandled = session.score.departuresHandled;
  const aircraftHandled = arrivalsHandled + departuresHandled;
  const aircraftSpawned = aircraft.length;
  const completionRatio = aircraftSpawned > 0 ? aircraftHandled / aircraftSpawned : 0;
  const completedWaitTotal = completed.reduce((sum, a) => sum + a.totalWaitSec, 0);
  const avgWaitSecPerHandled = aircraftHandled > 0 ? completedWaitTotal / aircraftHandled : 0;
  const maxWaitSec = completed.reduce((max, a) => Math.max(max, a.totalWaitSec), 0);

  const clearancesByKind: Partial<Record<AtcRequestKind, number>> = {};
  for (const kind of REQUEST_KINDS) {
    const n = clearances.filter((c) => c.kind === kind).length;
    if (n > 0) clearancesByKind[kind] = n;
  }

  // 応答時間: 要求の生成時刻から、対応する指示の発行時刻まで
  let responseCount = 0;
  let responseTotal = 0;
  let responseMax = 0;
  for (const request of Object.values(session.requests).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!request.clearanceId) continue;
    const clearance = session.clearances[request.clearanceId];
    if (!clearance) continue;
    const delta = clearance.issuedAtSec - request.createdAtSec;
    if (delta < 0) continue;
    responseCount += 1;
    responseTotal += delta;
    responseMax = Math.max(responseMax, delta);
  }
  const response: AtcResponseStats = {
    count: responseCount,
    avgSec: responseCount > 0 ? round1(responseTotal / responseCount) : 0,
    maxSec: responseMax,
  };

  // 時間帯別: 完了は completedAtSec、発行は issuedAtSec でバケットする
  let lastActivitySec = -1;
  for (const a of completed) lastActivitySec = Math.max(lastActivitySec, a.completedAtSec ?? 0);
  for (const c of clearances) lastActivitySec = Math.max(lastActivitySec, c.issuedAtSec);
  const hourly: AtcHourlyBucket[] = [];
  if (lastActivitySec >= 0) {
    const bucketCount = Math.floor(lastActivitySec / 3600) + 1;
    for (let h = 0; h < bucketCount; h++) {
      hourly.push({
        hourIndex: h,
        startSec: h * 3600,
        arrivalsHandled: 0,
        departuresHandled: 0,
        clearancesIssued: 0,
      });
    }
    for (const a of completed) {
      const bucket = hourly[Math.floor((a.completedAtSec ?? 0) / 3600)]!;
      if (a.kind === 'arrival') bucket.arrivalsHandled += 1;
      else bucket.departuresHandled += 1;
    }
    for (const c of clearances) {
      hourly[Math.floor(c.issuedAtSec / 3600)]!.clearancesIssued += 1;
    }
  }
  const peakHourlyClearances = hourly.reduce((max, b) => Math.max(max, b.clearancesIssued), 0);

  // 処理能力スコア（ゲーム値）: 処理率 70 点 + 待機効率 30 点。
  // 待機効率は処理済み1機あたり平均待機が 1800 秒で 0 になる線形減点。
  const completionPoints = 70 * completionRatio;
  const efficiencyPoints =
    aircraftHandled > 0 ? 30 * (1 - Math.min(1, avgWaitSecPerHandled / 1800)) : 0;
  const score = Math.max(0, Math.min(100, Math.round(completionPoints + efficiencyPoints)));

  const throughput: AtcThroughputReport = {
    arrivalsHandled,
    departuresHandled,
    aircraftHandled,
    aircraftSpawned,
    completionRatio: round3(completionRatio),
    clearancesIssued: session.score.clearancesIssued,
    clearancesByKind,
    totalWaitSec: session.score.totalWaitSec,
    avgWaitSecPerHandled: round1(avgWaitSecPerHandled),
    maxWaitSec,
    response,
    hourly,
    peakHourlyClearances,
    score,
  };

  // --- 総合: スコアは書き換えず、グレードにだけ安全側の上限を掛ける ---
  const rawGrade = gradeForScore(score);
  const cap = SAFETY_GRADE_CAP[safety.rating];
  const capped =
    GRADE_ORDER.indexOf(rawGrade) > GRADE_ORDER.indexOf(cap) ? cap : rawGrade;
  return {
    modelVersion: ATC_MODEL_VERSION,
    scenarioId: session.scenarioId,
    clockSec: session.clockSec,
    finished: session.finished,
    safety,
    throughput,
    overall: {
      grade: capped,
      throughputScore: score,
      safetyRating: safety.rating,
      cappedBySafety: capped !== rawGrade,
    },
  };
}
