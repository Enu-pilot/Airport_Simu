import { SCHEMA_VERSION, type AirportLayout } from '../model/types';

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

/** JSON から読み込む。形式が不正な場合は例外 */
export function importLayout(json: string): AirportLayout {
  const data = JSON.parse(json) as Partial<LayoutFile>;
  if (data.format !== SAVE_FORMAT) throw new Error('SkyPort のレイアウトファイルではありません');
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion < 1 || data.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`未対応のバージョンです: ${String(data.schemaVersion)}`);
  }
  const l = data.layout;
  if (!l || typeof l !== 'object') throw new Error('レイアウトがありません');
  // v1 → v2: ターミナル内部のエリアを追加
  if (data.schemaVersion < 2) {
    l.terminalAreas = {};
    l.schemaVersion = 2;
  }
  for (const k of RECORD_KEYS) {
    if (typeof l[k] !== 'object' || l[k] === null) throw new Error(`項目 ${k} が不正です`);
  }
  const site = l.site;
  if (!site || !Array.isArray(site.terrain) || site.terrain.length !== site.width * site.height) {
    throw new Error('敷地データが不正です');
  }
  return l;
}
