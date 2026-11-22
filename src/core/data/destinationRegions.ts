/**
 * 就航都市の表示用地域区分と表示順（2026-REGION、docs/42 §3.11）。
 * 既存の regionId（検証・ゴールデン・路線適性で使う粗い区分）とは別の、表示順専用の分類で、
 * 保存データ・シミュレーションには一切使わない。都市を足すときは destinations.ts への追加と
 * セットでここにも地域を登録すること（網羅は destinationRegionOrder.test.ts が検証する）。
 * 地域内の並びは destinations.ts の登録順を維持する（本モジュールは地域順だけを決める）。
 */
import { DESTINATION_DATA } from './destinations';

export type DestinationDisplayRegionId =
  | 'hokkaido'
  | 'tohoku'
  | 'kanto'
  | 'koshinetsu'
  | 'hokuriku'
  | 'tokai'
  | 'kinki'
  | 'chugoku'
  | 'shikoku'
  | 'kyushu'
  | 'okinawa'
  | 'east-asia'
  | 'southeast-asia'
  | 'south-asia'
  | 'central-asia'
  | 'middle-east'
  | 'europe'
  | 'africa'
  | 'north-america'
  | 'central-america'
  | 'south-america'
  | 'oceania';

export interface DestinationDisplayRegion {
  id: DestinationDisplayRegionId;
  /** 表示名 */
  name: string;
  scope: 'domestic' | 'international';
}

/** 地域の表示順の正本（国内: PO 指定の地方順。海外: PO 指定順に南アジア・中央アジア・アフリカ・中米を地理的位置へ挿入） */
export const DESTINATION_DISPLAY_REGIONS: readonly DestinationDisplayRegion[] = [
  { id: 'hokkaido', name: '北海道', scope: 'domestic' },
  { id: 'tohoku', name: '東北', scope: 'domestic' },
  { id: 'kanto', name: '関東', scope: 'domestic' },
  { id: 'koshinetsu', name: '甲信越', scope: 'domestic' },
  { id: 'hokuriku', name: '北陸', scope: 'domestic' },
  { id: 'tokai', name: '東海', scope: 'domestic' },
  { id: 'kinki', name: '近畿', scope: 'domestic' },
  { id: 'chugoku', name: '中国', scope: 'domestic' },
  { id: 'shikoku', name: '四国', scope: 'domestic' },
  { id: 'kyushu', name: '九州', scope: 'domestic' },
  { id: 'okinawa', name: '沖縄', scope: 'domestic' },
  { id: 'east-asia', name: '東アジア', scope: 'international' },
  { id: 'southeast-asia', name: '東南アジア', scope: 'international' },
  { id: 'south-asia', name: '南アジア', scope: 'international' },
  { id: 'central-asia', name: '中央アジア', scope: 'international' },
  { id: 'middle-east', name: '中東', scope: 'international' },
  { id: 'europe', name: 'ヨーロッパ', scope: 'international' },
  { id: 'africa', name: 'アフリカ', scope: 'international' },
  { id: 'north-america', name: '北アメリカ', scope: 'international' },
  { id: 'central-america', name: '中米・カリブ', scope: 'international' },
  { id: 'south-america', name: '南アメリカ', scope: 'international' },
  { id: 'oceania', name: 'オセアニア', scope: 'international' },
];

/** 目的地 ID → 表示用地域。南アメリカは現時点で該当都市なし（順序表にのみ存在する） */
export const DESTINATION_DISPLAY_REGION_BY_ID: Readonly<Record<string, DestinationDisplayRegionId>> = {
  // 北海道
  KTA: 'hokkaido', YKH: 'hokkaido', SPK: 'hokkaido', HKD: 'hokkaido', AKJ: 'hokkaido', KUH: 'hokkaido',
  OBO: 'hokkaido', MMB: 'hokkaido', WKJ: 'hokkaido', SHB: 'hokkaido', MBE: 'hokkaido', RIS: 'hokkaido',
  OKK: 'hokkaido',
  // 東北
  HSM: 'tohoku', SDJ: 'tohoku', AOJ: 'tohoku', AXT: 'tohoku', MSJ: 'tohoku', ONJ: 'tohoku',
  HNA: 'tohoku', GAJ: 'tohoku', SYO: 'tohoku', FKS: 'tohoku',
  // 関東
  TWN: 'kanto', TYO: 'kanto', IBR: 'kanto', HHC: 'kanto',
  // 甲信越
  KRG: 'koshinetsu', KIJ: 'koshinetsu', MMJ: 'koshinetsu',
  // 北陸
  KMQ: 'hokuriku', TOY: 'hokuriku',
  // 東海
  NGO: 'tokai', FSZ: 'tokai',
  // 近畿
  NSH: 'kinki', OSA: 'kinki', UKB: 'kinki', SHM: 'kinki', TJH: 'kinki',
  // 中国
  HIJ: 'chugoku', UBJ: 'chugoku', OKJ: 'chugoku', IWK: 'chugoku', IZO: 'chugoku', YGJ: 'chugoku',
  TTJ: 'chugoku', IWJ: 'chugoku', OKI: 'chugoku',
  // 四国
  MYJ: 'shikoku', TAK: 'shikoku', TKS: 'shikoku', KCZ: 'shikoku',
  // 九州
  AOS: 'kyushu', FUK: 'kyushu', KOJ: 'kyushu', NGS: 'kyushu', KMJ: 'kyushu', KMI: 'kyushu',
  OIT: 'kyushu', KKJ: 'kyushu', HSG: 'kyushu', KUM: 'kyushu', TNE: 'kyushu', TSJ: 'kyushu',
  IKI: 'kyushu', FUJ: 'kyushu', AXJ: 'kyushu',
  // 沖縄
  MSK: 'okinawa', OKA: 'okinawa', ISG: 'okinawa', MMY: 'okinawa', SHI: 'okinawa', UEO: 'okinawa',
  OGN: 'okinawa', TRA: 'okinawa', KTD: 'okinawa', MMD: 'okinawa', ASJ: 'okinawa', TKN: 'okinawa',
  OKE: 'okinawa', RNJ: 'okinawa', AGJ: 'okinawa', KXJ: 'okinawa',
  // 東アジア
  SEL: 'east-asia', TPE: 'east-asia', HKG: 'east-asia', PUS: 'east-asia', SHA: 'east-asia', PEK: 'east-asia',
  CAN: 'east-asia', SZX: 'east-asia', CTU: 'east-asia', CJU: 'east-asia', CJJ: 'east-asia', KHH: 'east-asia',
  TAO: 'east-asia', TNA: 'east-asia', DLC: 'east-asia', SHE: 'east-asia', HGH: 'east-asia', NJG: 'east-asia',
  XIY: 'east-asia', KMG: 'east-asia', CKG: 'east-asia', XMN: 'east-asia', FOC: 'east-asia', YNT: 'east-asia',
  HAK: 'east-asia', MFM: 'east-asia', VVO: 'east-asia', UBN: 'east-asia',
  // 東南アジア
  SIN: 'southeast-asia', BKK: 'southeast-asia', MNL: 'southeast-asia', HAN: 'southeast-asia', KUL: 'southeast-asia', SGN: 'southeast-asia',
  CGK: 'southeast-asia', CEB: 'southeast-asia', DAD: 'southeast-asia', BKI: 'southeast-asia', DPS: 'southeast-asia',
  // 南アジア
  DEL: 'south-asia', BOM: 'south-asia',
  // 中央アジア
  IKT: 'central-asia', TAS: 'central-asia',
  // 中東
  DXB: 'middle-east', IST: 'middle-east', DOH: 'middle-east', AUH: 'middle-east',
  // ヨーロッパ
  NDB: 'europe', BNH: 'europe', LHR: 'europe', CDG: 'europe', FRA: 'europe', HEL: 'europe',
  AMS: 'europe', ZRH: 'europe', VIE: 'europe', CPH: 'europe', MUC: 'europe', WAW: 'europe',
  FCO: 'europe', SVO: 'europe',
  // アフリカ
  LUM: 'africa', ADD: 'africa', CAI: 'africa',
  // 北アメリカ
  HNL: 'north-america', LAX: 'north-america', JFK: 'north-america', SFO: 'north-america', YVR: 'north-america', ORD: 'north-america',
  EWR: 'north-america', IAH: 'north-america', DEN: 'north-america', DFW: 'north-america', SEA: 'north-america', DTW: 'north-america',
  MSP: 'north-america', ATL: 'north-america', PDX: 'north-america', YYZ: 'north-america', YUL: 'north-america', YYC: 'north-america',
  // 中米・カリブ
  MEX: 'central-america',
  // オセアニア
  SYD: 'oceania', AKL: 'oceania', MEL: 'oceania', BNE: 'oceania', CNS: 'oceania', NAN: 'oceania',
  PPT: 'oceania', NOU: 'oceania', POM: 'oceania', ROR: 'oceania', GUM: 'oceania', SPN: 'oceania',
};

const REGION_ORDER_INDEX = new Map<DestinationDisplayRegionId, number>(DESTINATION_DISPLAY_REGIONS.map((r, i) => [r.id, i]));
const DATA_ORDER_INDEX = new Map<string, number>(DESTINATION_DATA.map((d, i) => [d.id, i]));

/** 目的地の表示用地域（未登録なら undefined） */
export const displayRegionOfDestination = (destinationId: string): DestinationDisplayRegionId | undefined =>
  DESTINATION_DISPLAY_REGION_BY_ID[destinationId];

/**
 * 目的地 ID の地域順比較: 地域順 → destinations.ts の登録順 → ID の辞書順。
 * 未登録の目的地は登録済みの後ろに置く（網羅テストで未登録自体を検出する前提）。
 */
export function compareDestinationIdsByDisplayRegion(aId: string, bId: string): number {
  const ra = DESTINATION_DISPLAY_REGION_BY_ID[aId];
  const rb = DESTINATION_DISPLAY_REGION_BY_ID[bId];
  const ia = ra ? (REGION_ORDER_INDEX.get(ra) ?? 0) : Number.MAX_SAFE_INTEGER;
  const ib = rb ? (REGION_ORDER_INDEX.get(rb) ?? 0) : Number.MAX_SAFE_INTEGER;
  if (ia !== ib) return ia - ib;
  const da = DATA_ORDER_INDEX.get(aId) ?? Number.MAX_SAFE_INTEGER;
  const db = DATA_ORDER_INDEX.get(bId) ?? Number.MAX_SAFE_INTEGER;
  if (da !== db) return da - db;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/** 目的地の配列を地域順に並べ替えた新しい配列を返す（元の配列は変更しない） */
export function sortDestinationsByDisplayRegion<T extends { id: string }>(destinations: readonly T[]): T[] {
  return [...destinations].sort((a, b) => compareDestinationIdsByDisplayRegion(a.id, b.id));
}

/** 目的地 ID の配列を地域順に並べ替えた新しい配列を返す（元の配列は変更しない） */
export function sortDestinationIdsByDisplayRegion(destinationIds: readonly string[]): string[] {
  return [...destinationIds].sort(compareDestinationIdsByDisplayRegion);
}
