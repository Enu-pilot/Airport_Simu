import { FREE_RUNWAY_MAX_M, FREE_RUNWAY_MIN_M } from '../model/catalog';
import { runwayDimsProblem } from '../model/runwayReference';
import { SCHEMA_VERSION, type AirportLayout } from '../model/types';
import { migrateLayout } from './migrate';

export const SAVE_FORMAT = 'skyport-layout';

export interface LayoutFile {
  format: typeof SAVE_FORMAT;
  schemaVersion: number;
  layout: AirportLayout;
}

export function exportLayout(layout: AirportLayout): string {
  const file: LayoutFile = { format: SAVE_FORMAT, schemaVersion: SCHEMA_VERSION, layout };
  return JSON.stringify(file);
}

const RECORD_KEYS = ['counters', 'runways', 'taxiNodes', 'taxiways', 'roadNodes', 'roads', 'stands', 'facilities', 'terminalAreas'] as const;

/** レイアウトの必須項目・型の検証。問題をすべて返す（空なら妥当） */
export function validateLayoutData(l: unknown): string[] {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return ['レイアウトがありません'];
  const layout = l as Partial<AirportLayout>;
  const errors: string[] = [];
  if (typeof layout.name !== 'string') errors.push('項目 name が不正です');
  for (const k of RECORD_KEYS) {
    const v = layout[k];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) errors.push(`項目 ${k} が不正です`);
  }
  const site = layout.site;
  if (!site || typeof site.width !== 'number' || typeof site.height !== 'number' || !Array.isArray(site.terrain) || site.terrain.length !== site.width * site.height) {
    errors.push('敷地データが不正です');
  }
  return errors;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const SUFFIXES = ['L', 'C', 'R', 'none'];
const RUNWAY_WIDTHS_M = [30, 45, 60];
const isFin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Phase 12 の新しい項目だけの検査（従来形の滑走路には新しい検査を足さない。今まで読めたファイルを読めなくしないため）。
 * 対象: alignment・自由形の項目・designatorSuffix・dims・magneticVariationDeg・ruleSet。
 */
export function checkRunwayFields(layout: AirportLayout, where: string): string[] {
  const errors: string[] = [];
  for (const [key, raw] of Object.entries(layout.runways)) {
    if (!isObj(raw)) continue; // 形そのものの不正は呼び出し側で報告済み
    const r = raw as Record<string, unknown>;
    const at = `${where}: 滑走路 ${key}`;
    if (r.designatorSuffix !== undefined && !SUFFIXES.includes(r.designatorSuffix as string)) errors.push(`${at} の designatorSuffix が不正です`);
    if (r.alignment === undefined) continue;
    if (r.alignment !== 'free') {
      errors.push(`${at} は未対応の形式です（新しいバージョンで作成された可能性）`);
      continue;
    }
    const s = r.start;
    if (!isObj(s) || !isFin(s.x) || !isFin(s.y)) errors.push(`${at} の始点が不正です`);
    if (!isFin(r.headingDeg) || r.headingDeg < 0 || r.headingDeg >= 360) errors.push(`${at} の方位（headingDeg）が不正です`);
    if (!isFin(r.lengthM) || r.lengthM < FREE_RUNWAY_MIN_M || r.lengthM > FREE_RUNWAY_MAX_M) errors.push(`${at} の長さ（lengthM）が不正です`);
    if (!RUNWAY_WIDTHS_M.includes(r.surfaceWidthM as number)) errors.push(`${at} の舗装幅が不正です`);
    if (r.dims !== undefined) {
      if (!isObj(r.dims)) errors.push(`${at} の dims が不正です`);
      else {
        // 未知のキー・有限でない値・負の値（標高を除く）・0 以下の幅は不正（編集の検査 sanitizeDims と同じ runwayDimsProblem）
        const bad = runwayDimsProblem(r.dims);
        if (bad !== null) errors.push(`${at} の dims.${bad} が不正です`);
      }
    }
  }
  const mv = (layout as { magneticVariationDeg?: unknown }).magneticVariationDeg;
  if (mv !== undefined && (!isFin(mv) || mv < -180 || mv > 180)) errors.push(`${where}: 磁気偏角が不正です`);
  const rs = (layout as { ruleSet?: unknown }).ruleSet;
  if (rs !== undefined && rs !== 'classic' && rs !== 'realistic') errors.push(`${where}: ruleSet が不正です`);
  return errors;
}

/** JSON から読み込む。形式が不正な場合は例外 */
export function importLayout(json: string): AirportLayout {
  const data = JSON.parse(json) as Partial<LayoutFile>;
  if (data.format !== SAVE_FORMAT) throw new Error('SkyPort のレイアウトファイルではありません');
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion < 1 || data.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`未対応のバージョンです: ${String(data.schemaVersion)}`);
  }
  const l = data.layout;
  if (!l || typeof l !== 'object') throw new Error('レイアウトがありません');
  migrateLayout(l, data.schemaVersion);
  const errors = validateLayoutData(l);
  if (errors.length) throw new Error(errors[0]);
  // Phase 12 の新しい項目だけの検査（localStorage の復元などもここを通る。従来形の有効なデータには何も足さない）
  const fieldErrors = checkRunwayFields(l, 'レイアウト');
  if (fieldErrors.length) throw new Error(fieldErrors[0]);
  return l;
}
