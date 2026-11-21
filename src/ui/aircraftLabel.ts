import type { CabinSpec, FleetEntry } from '../core/data/types';
import { AIRCRAFT_TYPES, resolveType, type AircraftType, type TypeTable } from '../core/sim/aircraftTypes';

/**
 * 機種表示のフォーマッタ（2026-CODE / 2026-FLEET）。
 * 表ごとにバラバラに実装せず、機種名・略号・仕様表記はここへ集約する。
 * - full（全文）: 型式名で表示。仕様バリアントは「787-8（335席/国内線機材）」形式（PO 指定の表記）。
 * - code（略号のみ）: 略号コード＋仕様マークで表示。「788（内）」「A35X（際）」、仕様なしはコードのみ。
 * 表示だけの整形であり、保存データやシミュレーションには影響しない。
 */
export type AircraftLabelMode = 'full' | 'code';

/** 仕様の全文表記 */
export const SPEC_LABEL: Record<CabinSpec, string> = { domestic: '国内線機材', international: '国際線機材' };
/** 仕様の略号マーク */
export const SPEC_MARK: Record<CabinSpec, string> = { domestic: '（内）', international: '（際）' };

/**
 * 略号コード対応表（Flightradar24 等で使われる機種略号＝ICAO 機種コード系を基に、
 * Boeing は先頭の B を落とす体系。PO 指定の 2 例: B787-8 → 788、A350-1000 → A35X（ICAO の A35K から変更）。
 * 貨物型は基コードに F を付す。計画doc（aircraft_catalog_fleet_plan §7）に同じ表を残す。
 */
export const AIRCRAFT_TYPE_CODES: Record<string, string> = {
  'B737-700': '737',
  'B737-800': '738',
  'B737-800W': '738',
  'B737-8': '7M8',
  'B767-300': '763',
  'B767-300ER': '763',
  'B767-300F': '763F',
  'B777-200': '772',
  'B777-200ER': '772',
  'B777-300': '773',
  'B777-300ER': '77W',
  'B777F': '77F',
  'B787-8': '788',
  'B787-9': '789',
  'B787-10': '78X',
  'B747-400': '744',
  'B747-8': '748',
  'B747-400F': '74F',
  'B747-8F': '748F',
  'A320-200': 'A320',
  'A320neo': 'A20N',
  'A321-200': 'A321',
  'A321neo': 'A21N',
  'A321P2F': 'A321F',
  'A330-200': 'A332',
  'A330-300': 'A333',
  'A350-900': 'A359',
  'A350-1000': 'A35X',
  'A380-800': 'A388',
  'A220-300': 'A223',
  'E170': 'E170',
  'E175': 'E75L',
  'E190': 'E190',
  'CRJ700': 'CRJ7',
  'DHC8-Q400': 'DH8D',
  'ATR42-600': 'AT46',
  'ATR72-600': 'AT76',
  'C919': 'C919',
  'MD-11F': 'M11F',
  // 汎用機材（架空の代替型式）は便宜コード
  'regional70': 'RJ70',
  'narrow180': 'NB180',
  'wide300': 'WB300',
};

/** 型式の略号コード。対応表にない型式は ICAO コード（shortLabel）から導く */
export function aircraftTypeCode(typeId: string, types: TypeTable = AIRCRAFT_TYPES): string {
  const known = AIRCRAFT_TYPE_CODES[typeId];
  if (known) return known;
  const t = types[typeId];
  if (!t) return typeId;
  return typeId.startsWith('B') && t.shortLabel.startsWith('B') ? t.shortLabel.slice(1) : t.shortLabel;
}

/**
 * 型式の短縮名（全文モードのバリアント表記用）: B787-8 → 787-8、B767-300ER → 767-300ER。
 * Boeing は先頭の B を落とし、それ以外は ID のまま。汎用機材は表示名を使う。
 */
export function typeShortName(type: AircraftType): string {
  if (type.generic) return type.label;
  return /^B\d/.test(type.id) ? type.id.slice(1) : type.id;
}

/** 機種だけの表示。full = 型式名（仕様ありは「787-8（国内線機材）」）、code = 「788（内）」 */
export function formatAircraftType(type: AircraftType, mode: AircraftLabelMode, spec?: CabinSpec): string {
  if (mode === 'code') return aircraftTypeCode(type.id) + (spec ? SPEC_MARK[spec] : '');
  return spec ? `${typeShortName(type)}（${SPEC_LABEL[spec]}）` : type.label;
}

/** フリート項目の表示（座席数つき）。full = 「787-8（335席/国内線機材）」、code = 「788（内）」 */
export function formatFleetEntry(entry: FleetEntry, mode: AircraftLabelMode, types: TypeTable = AIRCRAFT_TYPES): string {
  const type = resolveType(types, entry.typeId);
  if (mode === 'code') return aircraftTypeCode(entry.typeId, types) + (entry.spec ? SPEC_MARK[entry.spec] : '');
  const name = typeShortName(type);
  return entry.spec ? `${name}（${entry.seats}席/${SPEC_LABEL[entry.spec]}）` : `${name}（${entry.seats}席）`;
}

/** 契約・便など、型式＋仕様だけを表示する箇所用（座席数は含まない） */
export function formatTypeWithSpec(typeId: string, spec: CabinSpec | undefined, mode: AircraftLabelMode, types: TypeTable = AIRCRAFT_TYPES): string {
  return formatAircraftType(resolveType(types, typeId), mode, spec);
}
