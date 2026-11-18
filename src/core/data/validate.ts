import { AIRCRAFT_TYPES } from '../sim/aircraftTypes';
import type { AirlineInput, CountryDef, DestinationInput, RegionDef } from './types';

/**
 * 登録データの検証（3-03）。文の形式は固定: `[<種別> <id>] <field>: <理由>（<期待>）`。
 * 検証の読み方は docs/43_data_extension_guide.md。
 */
export interface CatalogRaw {
  destinations: DestinationInput[];
  airlines: AirlineInput[];
  countries: CountryDef[];
  regions: RegionDef[];
  aliases: Record<string, string>;
}

export interface CatalogIssue {
  kind: '就航都市' | '航空会社' | '国' | '別名';
  id: string;
  field: string;
  message: string;
  level: 'error' | 'warn';
}

export const LEGACY_AIRLINE_IDS = ['SK', 'NP', 'RJ', 'AQ', 'HB', 'AS', 'NW', 'ML'];
export const LEGACY_DESTINATION_IDS = [
  'KTA', 'TWN', 'MSK', 'YKH', 'KRG', 'AOS', 'NSH', 'HSM', 'TYO', 'OSA', 'SPK',
  'FUK', 'OKA', 'SEL', 'TPE', 'HKG', 'SIN', 'BKK', 'NDB', 'BNH', 'LUM',
];

const DEST_ID = /^[A-Z][A-Z0-9]{2}$/;
const AIRLINE_ID = /^[A-Z][A-Z0-9]$/;
const SERVICES = ['domesticPassenger', 'internationalPassenger', 'cargo'];
const AIRLINE_TYPES = ['fullService', 'lcc', 'regional'];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateCatalog(raw: CatalogRaw): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const push = (kind: CatalogIssue['kind'], id: string, field: string, reason: string, expected: string, level: 'error' | 'warn' = 'error') => {
    issues.push({ kind, id, field, message: `[${kind} ${id}] ${field}: ${reason}（${expected}）`, level });
  };
  const range = (kind: CatalogIssue['kind'], id: string, field: string, v: unknown, lo: number, hi: number, int = false) => {
    if (!finite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) {
      push(kind, id, field, `範囲外の値 ${String(v)}`, `${lo}〜${hi}${int ? ' の整数' : ''}`);
    }
  };
  const unlock = (kind: CatalogIssue['kind'], id: string, u: DestinationInput['unlock']) => {
    if (!u) return;
    if (u.minRating !== undefined) range(kind, id, 'unlock.minRating', u.minRating, 0, 100, true);
    if (u.minTier !== undefined) range(kind, id, 'unlock.minTier', u.minTier, 0, 7, true);
  };

  const countryIds = new Set(raw.countries.map((c) => c.id));
  const regionIds = new Set(raw.regions.map((r) => r.id));

  // 国・地域
  const seenCountry = new Set<string>();
  raw.countries.forEach((c, i) => {
    if (seenCountry.has(c.id)) push('国', c.id, 'id', '重複しています', `${i + 1} 番目の項目`);
    seenCountry.add(c.id);
    if (!c.name) push('国', c.id, 'name', '名前が空です', '1 文字以上');
    if (!regionIds.has(c.regionId)) push('国', c.id, 'regionId', `地域 "${c.regionId}" が REGION_DATA にありません`, '存在する地域 ID');
  });
  const seenRegion = new Set<string>();
  raw.regions.forEach((r, i) => {
    if (seenRegion.has(r.id)) push('国', r.id, 'id', '地域 ID が重複しています', `${i + 1} 番目の項目`);
    seenRegion.add(r.id);
  });

  // 就航都市
  const seenDest = new Set<string>();
  raw.destinations.forEach((d, i) => {
    const at = `${i + 1} 番目の項目`;
    if (!DEST_ID.test(d.id ?? '')) push('就航都市', String(d.id), 'id', '形式が不正です', '/^[A-Z][A-Z0-9]{2}$/');
    if (seenDest.has(d.id)) push('就航都市', d.id, 'id', '重複しています', `2 件目: ${at}`);
    seenDest.add(d.id);
    if (!d.name) push('就航都市', d.id, 'name', '名前が空です', '1 文字以上');
    if (!countryIds.has(d.countryId)) push('就航都市', d.id, 'countryId', `国 "${d.countryId}" が COUNTRY_DATA にありません`, '存在する国 ID');
    if (d.regionId !== undefined && !regionIds.has(d.regionId)) push('就航都市', d.id, 'regionId', `地域 "${d.regionId}" が REGION_DATA にありません`, '存在する地域 ID');
    range('就航都市', d.id, 'distanceKm', d.distanceKm, 50, 20_000);
    range('就航都市', d.id, 'population', d.population, 1_000, 40_000_000);
    if (d.demand) {
      if (d.demand.business !== undefined) range('就航都市', d.id, 'demand.business', d.demand.business, 0.1, 3.0);
      if (d.demand.leisure !== undefined) range('就航都市', d.id, 'demand.leisure', d.demand.leisure, 0.1, 3.0);
      if (d.demand.cargo !== undefined) range('就航都市', d.id, 'demand.cargo', d.demand.cargo, 0.1, 3.0);
    }
    if (d.congestion !== undefined) range('就航都市', d.id, 'congestion', d.congestion, 0, 1);
    if (d.passengerDemand !== undefined) range('就航都市', d.id, 'passengerDemand', d.passengerDemand, 0.3, 2.0);
    if (d.legacy && d.passengerDemand === undefined) push('就航都市', d.id, 'passengerDemand', 'legacy 項目には必須です', '0.3〜2.0');
    if (d.coordinates) {
      range('就航都市', d.id, 'coordinates.latitude', d.coordinates.latitude, -90, 90);
      range('就航都市', d.id, 'coordinates.longitude', d.coordinates.longitude, -180, 180);
    } else {
      push('就航都市', d.id, 'coordinates', '座標がありません（表示位置は 0,0 になります）', 'latitude -90〜90 / longitude -180〜180', 'warn');
    }
    unlock('就航都市', d.id, d.unlock);
  });
  // legacy の ID と順序の固定
  const legacyDestIds = raw.destinations.filter((d) => d.legacy).map((d) => d.id);
  if (JSON.stringify(legacyDestIds) !== JSON.stringify(LEGACY_DESTINATION_IDS)) {
    push('就航都市', legacyDestIds.join(','), 'legacy', 'legacy 項目の ID と順序が固定リストと一致しません', `先頭から ${LEGACY_DESTINATION_IDS.join(' ')} の順`);
  }
  if (raw.destinations.slice(0, legacyDestIds.length).some((d) => !d.legacy)) {
    push('就航都市', raw.destinations[0]?.id ?? '', 'legacy', 'legacy 項目は先頭に連続して置く必要があります', 'legacy は接頭辞');
  }

  // 航空会社
  const seenAirline = new Set<string>();
  const seenCode = new Set<string>();
  raw.airlines.forEach((a, i) => {
    const at = `${i + 1} 番目の項目`;
    if (!AIRLINE_ID.test(a.id ?? '')) push('航空会社', String(a.id), 'id', '形式が不正です', '/^[A-Z][A-Z0-9]$/');
    if (seenAirline.has(a.id)) push('航空会社', a.id, 'id', '重複しています', `2 件目: ${at}`);
    seenAirline.add(a.id);
    const code = a.code ?? a.id;
    if (seenCode.has(code)) push('航空会社', a.id, 'code', `便名の接頭辞 "${code}" が重複しています`, '会社ごとに一意');
    seenCode.add(code);
    if (!a.name) push('航空会社', a.id, 'name', '名前が空です', '1 文字以上');
    if (!AIRLINE_TYPES.includes(a.type)) push('航空会社', a.id, 'type', `種別 "${String(a.type)}" が不正です`, AIRLINE_TYPES.join(' / '));
    if (!Array.isArray(a.services) || a.services.length === 0) push('航空会社', a.id, 'services', 'サービスが空です', '1 件以上');
    else for (const s of a.services) if (!SERVICES.includes(s)) push('航空会社', a.id, 'services', `サービス "${String(s)}" が不正です`, SERVICES.join(' / '));
    if (!Array.isArray(a.fleet) || a.fleet.length === 0) push('航空会社', a.id, 'fleet', '機材が空です', '1 件以上');
    else a.fleet.forEach((f, j) => {
      const t = AIRCRAFT_TYPES[f.typeId];
      if (!t) push('航空会社', a.id, `fleet[${j}].typeId`, `機種 "${f.typeId}" が機種表にありません`, '存在する機種 ID');
      else if (!finite(f.seats) || f.seats < 1 || (t.maxPax != null && f.seats > t.maxPax)) {
        push('航空会社', a.id, `fleet[${j}].seats`, `座席 ${String(f.seats)} が機種 ${f.typeId} の最大旅客数 ${t.maxPax ?? '—'} を超えています`, `1〜${t.maxPax ?? '—'}`);
      }
    });
    if (a.baseLoadFactor !== undefined) range('航空会社', a.id, 'baseLoadFactor', a.baseLoadFactor, 0.3, 0.95);
    if (a.fareLevel !== undefined) range('航空会社', a.id, 'fareLevel', a.fareLevel, 0.5, 2.0);
    if (a.priceSensitivity !== undefined) range('航空会社', a.id, 'priceSensitivity', a.priceSensitivity, 0, 1);
    if (a.minOtp !== undefined) range('航空会社', a.id, 'minOtp', a.minOtp, 0.5, 0.99);
    if (a.livery) for (const k of ['body', 'tail', 'stripe', 'engine'] as const) range('航空会社', a.id, `livery.${k}`, a.livery[k], 0, 0xffffff, true);
    unlock('航空会社', a.id, a.unlock);
  });
  const legacyAirlineIds = raw.airlines.filter((a) => a.legacy).map((a) => a.id);
  if (JSON.stringify(legacyAirlineIds) !== JSON.stringify(LEGACY_AIRLINE_IDS)) {
    push('航空会社', legacyAirlineIds.join(','), 'legacy', 'legacy 項目の ID と順序が固定リストと一致しません', `先頭から ${LEGACY_AIRLINE_IDS.join(' ')} の順`);
  }
  if (raw.airlines.slice(0, legacyAirlineIds.length).some((a) => !a.legacy)) {
    push('航空会社', raw.airlines[0]?.id ?? '', 'legacy', 'legacy 項目は先頭に連続して置く必要があります', 'legacy は接頭辞');
  }

  // 別名
  const allIds = new Set([...seenDest, ...seenAirline]);
  for (const [from, to] of Object.entries(raw.aliases)) {
    if (allIds.has(from)) push('別名', from, 'id', '別名の元が既存の ID と衝突しています', '既存 ID とは別の文字列');
    if (!allIds.has(to)) push('別名', from, `→ ${to}`, '別名の先の ID がありません', '存在する ID');
  }

  // 国際線の会社が 1 社もない場合は警告
  if (!raw.airlines.some((a) => !a.retired && a.services?.includes('internationalPassenger'))) {
    push('航空会社', '*', 'services', '国際旅客を持つ会社がありません', 'internationalPassenger を持つ会社が 1 社以上', 'warn');
  }
  return issues;
}

export class CatalogError extends Error {
  readonly issues: CatalogIssue[];
  constructor(issues: CatalogIssue[]) {
    super(issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n'));
    this.name = 'CatalogError';
    this.issues = issues;
  }
}
