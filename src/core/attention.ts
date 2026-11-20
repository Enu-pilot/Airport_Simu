import { layoutCapabilities, type CapabilityReading, type CapabilityState } from './capability';
import type { CompanyState, DailyReport } from './economy/company';
import type { Tile } from './geometry/vec';
import type { AirportLayout } from './model/types';
import type { MissBottleneck } from './sim/missBreakdown';
import type { LayoutAnalysis } from './validation/validate';

/**
 * UI 改善 案1: 要対応リストの一元化。
 *
 * 配置・接続チェック（検証）、施設の能力状態（共通能力契約）、直近日報の運航実績に
 * 散らばっている「要対応」を、帯（band）付きの1本のリストに集約する純関数。
 * 並び順は帯方式: high / mid / low の3帯に分け、帯内は各ソースの主指標（metric）の
 * 降順にする。単位の違う指標（人数・秒・%）を単一スコアに合算しない。
 * 日報を読むだけ・既存の解析結果を写すだけで、sim の計算・判定は一切変えない。
 * 「問題なし」と「未計測（日報がない）」は区別する: 日報が無ければ日報由来の
 * 項目は出さず、呼び出し側がその旨を表示できるようにする。
 * 検証項目の全文は i18n の issueText が正本なので、ここでは帯分類に留め、
 * title は分類名、detail は項目コードとする（画面の第1セクションが全文を出す）。
 */

export type AttentionBand = 'high' | 'mid' | 'low';

export type AttentionSource =
  | 'validation'
  | 'capability'
  | 'missed'
  | 'groundWaits'
  | 'processPeak'
  | 'morningReadiness'
  | 'hub'
  | 'cargo'
  | 'access'
  | 'maintenance'
  | 'ops';

/**
 * 運航中アラートのうち「注意」分をインボックスへ渡すための入力（アラートC の出し分け）。
 * 重大（critical）は地図上のスタックだけに出し、ここへは渡さない（呼び出し側が partition する）。
 * core は UI 層のアラート型に依存しないため、必要な項目だけの構造で受ける。
 */
export interface OpsAlertAttentionInput {
  key: string;
  title: string;
  detail?: string;
  count?: number;
  targetId?: string | null;
}

export interface AttentionItem {
  /** `${source}:${subjectId}`（決定的なキー） */
  id: string;
  source: AttentionSource;
  /** ソース内での対象 ID（施設 ID、工程名、理由キーなど）。testid の末尾に使う */
  subjectId: string;
  band: AttentionBand;
  title: string;
  detail: string;
  /** 帯内ソート用の主指標。ソースごとに単位が違うため、帯をまたいだ比較には使わない */
  metric: number;
  /** 地図ジャンプ先のエンティティ ID（無い項目はジャンプしない） */
  targetId?: string;
  /** 地図ジャンプ先のタイル位置（検証項目のみ） */
  at?: Tile;
}

/** 帯付けの閾値。調整はこの表1か所で完結させる */
export const ATTENTION_THRESHOLDS = {
  /** 工程ピーク使用率: これ以上で high */
  processUtilizationHigh: 1,
  /** 工程ピーク使用率: これ以上で mid */
  processUtilizationMid: 0.85,
  /** 工程ピーク使用率: これ未満は要対応として出さない */
  processUtilizationLow: 0.7,
  /** 乗り遅れ: 分類ごとの合計人数がこれ以上で、その分類の最大項目を high */
  missedCategoryHigh: 100,
  /** 資源待ち: 1理由の累計秒がこれ以上で mid */
  groundWaitSecMid: 3600,
  /** 道路の平均遅れ（分）: これ未満は日常のばらつきとして出さない */
  roadDelayMinLow: 5,
} as const;

const BAND_RANK: Record<AttentionBand, number> = { high: 0, mid: 1, low: 2 };

/** i18n の CAPABILITY_STATE_LABEL の写し（core は i18n を import しない流儀のため。文言の正本は i18n 側） */
const CAPABILITY_STATE_TEXT: Partial<Record<CapabilityState, string>> = {
  zeroCapacity: '能力 0',
  disconnected: '未接続',
  underConstruction: '建設中',
  closed: '閉鎖中',
  failed: '故障・停止',
  resourceShortage: '人員・車両不足',
  supplyShortage: '供給不足',
};

/** 要対応として拾う能力状態とその帯（operational / uncomputed / notInstalled は対象外） */
const CAPABILITY_BAND: Partial<Record<CapabilityState, AttentionBand>> = {
  disconnected: 'high',
  failed: 'high',
  closed: 'mid',
  zeroCapacity: 'mid',
  resourceShortage: 'mid',
  supplyShortage: 'mid',
  underConstruction: 'low',
};

/** i18n の MISS_BOTTLENECK_LABEL の写し（同上） */
const MISS_TEXT: Record<MissBottleneck, string> = {
  checkIn: 'チェックイン待ち',
  security: '保安検査待ち',
  emigration: '出国審査待ち',
  immigration: '入国審査待ち',
  customs: '税関待ち',
  transferSecurity: '乗継保安検査待ち',
  gate: '搭乗口・待合で待機',
  walking: '移動中',
  bus: 'バス待ち・乗車中',
  access: '空港へのアクセス中',
  transferLate: '乗継時間の不足',
  unreachable: '到達不能',
  routePending: '連絡通路の完成待ち',
  noGate: 'ゲートなし',
  facilityClosed: '施設閉鎖',
  other: 'その他',
};

/** DayReview の資源待ち表記と同じ対応 */
const GROUND_WAIT_TEXT: Record<string, string> = {
  noVehicle: '車両不足',
  noStaff: '作業員不足',
  noEngineer: '整備士不足',
};

/** 工程ピークの step（ProcessStep）の表示名。i18n の PROCESS_STEP_LABEL の写し（9工程） */
const PROCESS_STEP_TEXT: Record<string, string> = {
  checkIn: 'チェックイン',
  security: '保安検査場',
  emigration: '出国審査',
  immigration: '入国審査',
  customs: '税関',
  transferSecurity: '乗継保安検査',
  restroom: 'トイレ',
  apronBus: 'ランプバス',
  access: 'アクセス到着',
};

/** 工程ピークの開始表記: ローリング 60 分の開始分（peakStartMin）があればそれを正とし、無い旧日報は時台に落とす */
const peakText = (p: { peakHour: number; peakStartMin?: number }): string =>
  p.peakStartMin !== undefined
    ? `ピーク ${String(Math.floor(p.peakStartMin / 60)).padStart(2, '0')}:${String(p.peakStartMin % 60).padStart(2, '0')}〜の60分`
    : `ピーク ${p.peakHour} 時台`;

function entityName(layout: AirportLayout, id: string): string {
  return layout.facilities[id]?.name ?? layout.terminalAreas[id]?.name ?? id;
}

const fmtNum = (v: number): string => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));

export function buildAttentionItems(input: {
  layout: AirportLayout;
  analysis: LayoutAnalysis;
  company: CompanyState;
  /**
   * 能力の読み取り列（合成済み）。運航中は composeCapabilityReadings で
   * operationalStateReadings（正本）を合成した列を渡すと、capability 由来に
   * closed / failed / resourceShortage も出る。省略時は layoutCapabilities のみ（従来どおり）。
   */
  capabilities?: CapabilityReading[];
  /**
   * 運航中アラートの「注意」分（アラートC）。渡された分だけ source 'ops'・帯 mid で出す。
   * 省略時・空のときは従来どおり（運航していないときはこちらが通常）。
   */
  opsAlerts?: readonly OpsAlertAttentionInput[];
}): AttentionItem[] {
  const { layout, analysis, company } = input;
  const items: AttentionItem[] = [];
  const push = (item: Omit<AttentionItem, 'id'>) => {
    items.push({ ...item, id: `${item.source}:${item.subjectId}` });
  };

  // (a) 検証 issues: error は high、warning は low。info は対象外（第1セクションの表示に任せる）
  for (const iss of analysis.issues) {
    if (iss.severity === 'info') continue;
    push({
      source: 'validation',
      subjectId: iss.key,
      band: iss.severity === 'error' ? 'high' : 'low',
      title: iss.severity === 'error' ? '配置・接続のエラー' : '配置・接続の警告',
      detail: `項目コード ${iss.code}`,
      metric: 0,
      ...(iss.targets[0] ? { targetId: iss.targets[0] } : {}),
      ...(iss.at ? { at: iss.at } : {}),
    });
  }

  // (b) 能力状態: 案3で統一した能力経路（ポータル到達不能も disconnected として出る。
  // 運航中の閉鎖・故障・人員不足は、合成済みの読み取り列を渡したときだけ
  // closed / failed / resourceShortage として出る = F6-04 の operationalStateReadings が正本）
  // targetId は subjectId がレイアウトの実体に対応する場合だけ付ける
  // （staff:absence や belt:… のような実体の無い ID を地図フォーカス先にしない）
  const isEntity = (id: string): boolean =>
    !!(layout.facilities[id] ?? layout.terminalAreas[id] ?? layout.stands[id] ?? layout.runways[id]);
  for (const r of input.capabilities ?? layoutCapabilities(layout)) {
    const band = CAPABILITY_BAND[r.state];
    if (!band) continue;
    const stateText = CAPABILITY_STATE_TEXT[r.state] ?? r.state;
    push({
      source: 'capability',
      subjectId: r.subjectId,
      band,
      title: r.label,
      detail:
        r.theoretical !== null
          ? `${stateText}（理論 ${fmtNum(r.theoretical)} ${r.unit} / 有効 ${fmtNum(r.effective ?? 0)} ${r.unit}）`
          : stateText,
      metric: r.theoretical ?? 0,
      ...(isEntity(r.subjectId) ? { targetId: r.subjectId } : {}),
    });
  }

  // (b2) 運航中アラートの「注意」分（アラートC: 重大はスタックのみ、注意はインボックスのみ）。
  // 日報の有無に依らないライブ項目なので、(c) の日報ゲートの外で出す。
  // targetId は能力由来と同じく、レイアウトの実体に対応する場合だけ付ける
  for (const a of input.opsAlerts ?? []) {
    push({
      source: 'ops',
      subjectId: a.key,
      band: 'mid',
      title: a.title,
      detail: a.detail ?? '',
      metric: a.count ?? 1,
      ...(a.targetId && isEntity(a.targetId) ? { targetId: a.targetId } : {}),
    });
  }

  // (c) 直近日報: 無ければ日報由来の項目は出さない（「未計測」を「問題なし」と混同しない）
  const report: DailyReport | undefined = company.reports[company.reports.length - 1];
  if (report) {
    // 乗り遅れの内訳: 項目ごとに出し、分類の合計が閾値以上の分類は最大項目を high にする
    const missed = report.missedBreakdown ?? [];
    const categoryTotal = new Map<MissBottleneck, number>();
    const categoryTop = new Map<MissBottleneck, number>();
    for (const e of missed) {
      categoryTotal.set(e.category, (categoryTotal.get(e.category) ?? 0) + e.count);
      categoryTop.set(e.category, Math.max(categoryTop.get(e.category) ?? 0, e.count));
    }
    for (const e of missed) {
      if (e.count <= 0) continue;
      const isTopOfBigCategory =
        (categoryTotal.get(e.category) ?? 0) >= ATTENTION_THRESHOLDS.missedCategoryHigh &&
        e.count === categoryTop.get(e.category);
      push({
        source: 'missed',
        subjectId: `${e.category}-${e.spotId ?? 'unknown'}`,
        band: isTopOfBigCategory ? 'high' : 'low',
        title: `乗り遅れ: ${MISS_TEXT[e.category] ?? e.category}`,
        detail: `${e.count} 人${e.spotId ? `（${entityName(layout, e.spotId)}）` : ''}`,
        metric: e.count,
        ...(e.spotId ? { targetId: e.spotId } : {}),
      });
    }

    // 資源待ち: 理由ごとの累計秒
    for (const w of report.groundWaits ?? []) {
      if (w.sec <= 0) continue;
      push({
        source: 'groundWaits',
        subjectId: w.reason,
        band: w.sec >= ATTENTION_THRESHOLDS.groundWaitSecMid ? 'mid' : 'low',
        title: `資源待ち: ${GROUND_WAIT_TEXT[w.reason] ?? w.reason}`,
        detail: `累計 ${Math.round(w.sec / 60)} 分の待ち`,
        metric: w.sec,
      });
    }

    // 工程ピーク: ターミナル別があればそちらを優先する（空港全体と二重に出さない）
    const byTerminal = report.processPeakByTerminal ?? [];
    const peaks =
      byTerminal.length > 0
        ? byTerminal.map((p) => ({ ...p, subjectId: `${p.terminalId}:${p.step}`, terminalId: p.terminalId as string | undefined }))
        : (report.processPeak ?? []).map((p) => ({ ...p, subjectId: p.step, terminalId: undefined as string | undefined }));
    for (const p of peaks) {
      if (p.utilization === null) continue;
      const band: AttentionBand | null =
        p.utilization >= ATTENTION_THRESHOLDS.processUtilizationHigh
          ? 'high'
          : p.utilization >= ATTENTION_THRESHOLDS.processUtilizationMid
            ? 'mid'
            : p.utilization >= ATTENTION_THRESHOLDS.processUtilizationLow
              ? 'low'
              : null;
      if (!band) continue;
      push({
        source: 'processPeak',
        subjectId: p.subjectId,
        band,
        title: `工程の混雑: ${PROCESS_STEP_TEXT[p.step] ?? p.step}${p.terminalId ? `（${p.terminalId}）` : ''}`,
        detail: `使用率 ${Math.round(p.utilization * 100)}%（${peakText(p)}・平均待ち ${Math.round(p.avgWaitSec)} 秒）`,
        metric: p.utilization,
      });
    }

    // 翌朝の出発可能機数: リスクありは mid
    if (report.morningReadiness && report.morningReadiness.atRisk >= 1) {
      push({
        source: 'morningReadiness',
        subjectId: 'morningReadiness',
        band: 'mid',
        title: '翌朝の出発にリスク',
        detail: `06:00–10:00 の滞泊便 ${report.morningReadiness.scheduled} 機中 ${report.morningReadiness.atRisk} 機がリスクあり`,
        metric: report.morningReadiness.atRisk,
      });
    }

    // 乗継の乗り遅れ
    if (report.hub && report.hub.missed > 0) {
      push({
        source: 'hub',
        subjectId: 'hub',
        band: 'low',
        title: '乗継の乗り遅れ',
        detail: `${report.hub.missed} 人（発生 ${report.hub.spawned} 人・接続 ${report.hub.connected} 人）`,
        metric: report.hub.missed,
      });
    }

    // 貨物の積み残し: あれば mid
    if (report.cargo && report.cargo.leftoverM3 > 0) {
      push({
        source: 'cargo',
        subjectId: 'cargo',
        band: 'mid',
        title: '貨物の積み残し',
        detail: `積み残し ${fmtNum(report.cargo.leftoverM3)} m³（取扱 ${fmtNum(report.cargo.carriedM3)} m³）`,
        metric: report.cargo.leftoverM3,
      });
    }

    // アクセス: 駐車場の満車あふれ / 道路の平均遅れ（日報の KPI 側に記録される）
    if (report.kpi?.parkingFull !== undefined && report.kpi.parkingFull > 0) {
      push({
        source: 'access',
        subjectId: 'parkingFull',
        band: 'low',
        title: '駐車場の満車',
        detail: `満車で停められなかった車 ${report.kpi.parkingFull} 台`,
        metric: report.kpi.parkingFull,
      });
    }
    if (report.kpi?.roadDelayMin !== undefined && report.kpi.roadDelayMin >= ATTENTION_THRESHOLDS.roadDelayMinLow) {
      push({
        source: 'access',
        subjectId: 'roadDelay',
        band: 'low',
        title: '道路の遅れ',
        detail: `平均 ${fmtNum(report.kpi.roadDelayMin)} 分の遅れ`,
        metric: report.kpi.roadDelayMin,
      });
    }

    // 整備: 期限超過 / 整備起因の欠航
    if (report.maintenance && report.maintenance.overdue > 0) {
      push({
        source: 'maintenance',
        subjectId: 'overdue',
        band: 'low',
        title: '整備の期限超過',
        detail: `周期整備の期限を超過した機体 ${report.maintenance.overdue} 機`,
        metric: report.maintenance.overdue,
      });
    }
    if (report.maintenance && report.maintenance.techCancelled > 0) {
      push({
        source: 'maintenance',
        subjectId: 'techCancelled',
        band: 'low',
        title: '整備起因の欠航',
        detail: `${report.maintenance.techCancelled} 便`,
        metric: report.maintenance.techCancelled,
      });
    }
  }

  // 帯方式の並び: 帯 → 帯内は主指標の降順 → 同点は id 順（決定的）
  items.sort((a, b) => BAND_RANK[a.band] - BAND_RANK[b.band] || b.metric - a.metric || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return items;
}
