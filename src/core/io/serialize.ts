import { FACILITY_SPECS, FREE_RUNWAY_MAX_M, FREE_RUNWAY_MIN_M } from '../model/catalog';
import { runwayDimsProblem } from '../model/runwayReference';
import { SCHEMA_VERSION, type AirportLayout } from '../model/types';
import { COUNTRIES } from '../economy/registry';
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
  if (layout.countryId !== undefined && !COUNTRIES.some((country) => country.id === layout.countryId)) errors.push('項目 countryId が不正です');
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
const ROAD_CLASSES = ['public', 'service', 'rail', 'walkway', 'fuel'];
const CONNECTORS = ['stairs', 'escalator', 'elevator', 'ramp', 'railRamp', 'pipeRiser'];

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
  for (const [id, n] of Object.entries(layout.roadNodes)) {
    if (n.level !== undefined && (!Number.isInteger(n.level) || n.level < -5 || n.level > 10)) errors.push(`${where}: 道路ノード ${id} の level が不正です`);
    if (n.elevationM !== undefined && !isFin(n.elevationM)) errors.push(`${where}: 道路ノード ${id} の elevationM が不正です`);
  }
  for (const [id, e] of Object.entries(layout.roads)) {
    if (!ROAD_CLASSES.includes(e.roadClass)) errors.push(`${where}: 道路 ${id} の roadClass が不正です`);
    if (e.connectorKind !== undefined && !CONNECTORS.includes(e.connectorKind)) errors.push(`${where}: 道路 ${id} の connectorKind が不正です`);
    if (e.capacityPerHour !== undefined && (!isFin(e.capacityPerHour) || e.capacityPerHour <= 0)) errors.push(`${where}: 道路 ${id} の capacityPerHour は正の有限値が必要です`);
    if (e.travelSec !== undefined && (!isFin(e.travelSec) || e.travelSec <= 0)) errors.push(`${where}: 道路 ${id} の travelSec は正の有限値が必要です`);
  }
  for (const f of Object.values(layout.facilities)) {
    const level = f.props?.level;
    if (level !== undefined && (!Number.isInteger(level) || Number(level) < -5 || Number(level) > 10)) errors.push(`${where}: 施設 ${f.id} の level が不正です`);
    if (f.mapLevel !== undefined && (!Number.isInteger(f.mapLevel) || f.mapLevel < -5 || f.mapLevel > 10)) errors.push(`${where}: 施設 ${f.id} の mapLevel が不正です`);
    if (f.parentFacilityId !== undefined) {
      const parent = layout.facilities[f.parentFacilityId];
      if (!parent || parent.id === f.id || FACILITY_SPECS[parent.kind]?.layer !== 'building') errors.push(`${where}: 施設 ${f.id} の parentFacilityId が不正です`);
      if (!Number.isInteger(f.floorIndex) || (f.floorIndex ?? 0) < -5 || (f.floorIndex ?? 0) >= Number(parent?.props.levels ?? 1)) errors.push(`${where}: 施設 ${f.id} の floorIndex が不正です`);
      if (parent && f.mapLevel !== undefined && f.mapLevel !== (parent.mapLevel ?? (parent.kind === 'railStation' ? Number(parent.props.level ?? 0) : 0))) {
        errors.push(`${where}: 施設 ${f.id} の階層が親施設と一致しません`);
      }
    } else if (f.floorIndex !== undefined) errors.push(`${where}: 施設 ${f.id} に親がないのに floorIndex が設定されています`);
  }
  const transitLinks = layout.terminalLinks === undefined ? {} : isObj(layout.terminalLinks) ? layout.terminalLinks : {};
  if (layout.terminalLinks !== undefined && !isObj(layout.terminalLinks)) errors.push(`${where}: terminalLinks が不正です`);
  for (const [id, raw] of Object.entries(transitLinks)) {
    if (!isObj(raw)) { errors.push(`${where}: ターミナル連絡設備 ${id} が不正です`); continue; }
    const link = raw as Record<string, unknown>;
    if (link.id !== id) errors.push(`${where}: ターミナル連絡設備 ${id} の ID が一致しません`);
    if (!['walkway', 'movingWalkway', 'elevatedWalkway', 'escalator', 'elevator'].includes(String(link.kind))) errors.push(`${where}: ターミナル連絡設備 ${id} の kind が不正です`);
    if (typeof link.fromAreaId !== 'string' || typeof link.toAreaId !== 'string' || link.fromAreaId === link.toAreaId) errors.push(`${where}: ターミナル連絡設備 ${id} の接続エリアが不正です`);
    if (!isFin(link.distanceM) || link.distanceM <= 0 || !isFin(link.travelSec) || link.travelSec <= 0) errors.push(`${where}: ターミナル連絡設備 ${id} の距離・所要時間が不正です`);
    if (link.capacityPerHour !== undefined && (!isFin(link.capacityPerHour) || link.capacityPerHour <= 0)) errors.push(`${where}: ターミナル連絡設備 ${id} の capacityPerHour が不正です`);
    if (link.widthM !== undefined && (!isFin(link.widthM) || link.widthM <= 0)) errors.push(`${where}: ターミナル連絡設備 ${id} の widthM が不正です`);
    if (link.elevationM !== undefined && (!isFin(link.elevationM) || link.elevationM <= 0)) errors.push(`${where}: ターミナル連絡設備 ${id} の elevationM が不正です`);
    if (link.aircraftClearanceM !== undefined && (!isFin(link.aircraftClearanceM) || link.aircraftClearanceM <= 0)) errors.push(`${where}: ターミナル連絡設備 ${id} の aircraftClearanceM が不正です`);
    if (typeof link.bidirectional !== 'boolean' || !['operational', 'underConstruction', 'planned'].includes(String(link.buildState))) errors.push(`${where}: ターミナル連絡設備 ${id} の状態が不正です`);
    if (!Array.isArray(link.allowedZones) || !link.allowedZones.length || link.allowedZones.some((zone) => zone !== 'landside' && zone !== 'departure' && zone !== 'arrival')) errors.push(`${where}: ターミナル連絡設備 ${id} の利用区域が不正です`);
  }
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
