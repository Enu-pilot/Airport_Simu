import { describe, expect, it } from 'vitest';
import { AIRLINES, COUNTRIES, DESTINATIONS, REGIONS } from '../../src/core/economy/registry';

/**
 * フェーズ 3 の回帰固定（計画 A1）: 旧 registry の 8 社・21 都市・9 国・10 地域の値と順序を逐語で固定する。
 * この表が崩れると market なしの旧ゲームの提案の乱数列が変わる。値を変えるときは計画の手順（docs/43）に従うこと。
 */
const LEGACY_AIRLINES = [
 {
  "id": "SK",
  "code": "SK",
  "name": "スカイライン航空",
  "type": "fullService",
  "fleet": [
   {
    "typeId": "B737-800W",
    "seats": 166
   },
   {
    "typeId": "B787-9",
    "seats": 266
   },
   {
    "typeId": "B777-300ER",
    "seats": 316
   },
   {
    "typeId": "B787-10",
    "seats": 320
   },
   {
    "typeId": "B767-300ER",
    "seats": 250
   }
  ],
  "priceSensitivity": 0.3,
  "minOtp": 0.85,
  "services": [
   "domesticPassenger",
   "internationalPassenger"
  ]
 },
 {
  "id": "NP",
  "code": "NP",
  "name": "ノースパシフィック航空",
  "type": "fullService",
  "fleet": [
   {
    "typeId": "A320neo",
    "seats": 180
   },
   {
    "typeId": "A350-900",
    "seats": 310
   },
   {
    "typeId": "B777-300",
    "seats": 400
   },
   {
    "typeId": "A380-800",
    "seats": 520
   },
   {
    "typeId": "A350-1000",
    "seats": 370
   },
   {
    "typeId": "A321neo",
    "seats": 194
   }
  ],
  "priceSensitivity": 0.35,
  "minOtp": 0.8,
  "services": [
   "domesticPassenger",
   "internationalPassenger"
  ]
 },
 {
  "id": "RJ",
  "code": "RJ",
  "name": "リージョナルジェット",
  "type": "regional",
  "fleet": [
   {
    "typeId": "regional70",
    "seats": 70
   },
   {
    "typeId": "E190",
    "seats": 95
   },
   {
    "typeId": "E175",
    "seats": 76
   },
   {
    "typeId": "ATR72-600",
    "seats": 70
   }
  ],
  "priceSensitivity": 0.5,
  "minOtp": 0.75,
  "services": [
   "domesticPassenger"
  ]
 },
 {
  "id": "AQ",
  "code": "AQ",
  "name": "アクアエア",
  "type": "lcc",
  "fleet": [
   {
    "typeId": "A320-200",
    "seats": 180
   },
   {
    "typeId": "A320neo",
    "seats": 186
   }
  ],
  "priceSensitivity": 0.8,
  "minOtp": 0.7,
  "services": [
   "domesticPassenger",
   "internationalPassenger"
  ]
 },
 {
  "id": "HB",
  "code": "HB",
  "name": "ハミングバード",
  "type": "lcc",
  "fleet": [
   {
    "typeId": "regional70",
    "seats": 70
   },
   {
    "typeId": "B737-800",
    "seats": 184
   },
   {
    "typeId": "B737-8",
    "seats": 189
   }
  ],
  "priceSensitivity": 0.7,
  "minOtp": 0.7,
  "services": [
   "domesticPassenger"
  ]
 },
 {
  "id": "AS",
  "code": "AS",
  "name": "アステル航空",
  "type": "fullService",
  "fleet": [
   {
    "typeId": "A320neo",
    "seats": 180
   },
   {
    "typeId": "B787-9",
    "seats": 280
   }
  ],
  "priceSensitivity": 0.32,
  "minOtp": 0.84,
  "minimumAirportRating": 60,
  "services": [
   "domesticPassenger",
   "internationalPassenger"
  ]
 },
 {
  "id": "NW",
  "code": "NW",
  "name": "ノルドウィング航空",
  "type": "fullService",
  "fleet": [
   {
    "typeId": "A321neo",
    "seats": 200
   },
   {
    "typeId": "B787-10",
    "seats": 310
   }
  ],
  "priceSensitivity": 0.38,
  "minOtp": 0.82,
  "minimumAirportRating": 65,
  "services": [
   "domesticPassenger",
   "internationalPassenger"
  ]
 },
 {
  "id": "ML",
  "code": "ML",
  "name": "ミッドランド航空",
  "type": "regional",
  "fleet": [
   {
    "typeId": "E175",
    "seats": 78
   },
   {
    "typeId": "E190",
    "seats": 95
   }
  ],
  "priceSensitivity": 0.55,
  "minOtp": 0.78,
  "minimumAirportRating": 55,
  "services": [
   "domesticPassenger"
  ]
 }
] as const;
const LEGACY_DESTINATIONS = [
 {
  "id": "KTA",
  "name": "北港",
  "countryId": "JP",
  "regionId": "north",
  "coordinates": {
   "latitude": 43.1,
   "longitude": 141.3
  },
  "distanceKm": 450,
  "passengerDemand": 1,
  "cargoDemand": 0.72
 },
 {
  "id": "TWN",
  "name": "東湾市",
  "countryId": "JP",
  "regionId": "east",
  "coordinates": {
   "latitude": 35.7,
   "longitude": 139.7
  },
  "distanceKm": 800,
  "passengerDemand": 1.15,
  "cargoDemand": 1.12
 },
 {
  "id": "MSK",
  "name": "南岬",
  "countryId": "JP",
  "regionId": "south",
  "coordinates": {
   "latitude": 26.2,
   "longitude": 127.7
  },
  "distanceKm": 300,
  "passengerDemand": 0.85,
  "cargoDemand": 0.65
 },
 {
  "id": "YKH",
  "name": "雪原",
  "countryId": "JP",
  "regionId": "north",
  "coordinates": {
   "latitude": 44,
   "longitude": 142
  },
  "distanceKm": 1200,
  "passengerDemand": 0.95,
  "cargoDemand": 0.82
 },
 {
  "id": "KRG",
  "name": "霧ヶ丘",
  "countryId": "JP",
  "regionId": "central",
  "coordinates": {
   "latitude": 36.2,
   "longitude": 138.3
  },
  "distanceKm": 600,
  "passengerDemand": 0.8,
  "cargoDemand": 0.68
 },
 {
  "id": "AOS",
  "name": "青島",
  "countryId": "JP",
  "regionId": "west",
  "coordinates": {
   "latitude": 33.6,
   "longitude": 130.4
  },
  "distanceKm": 1500,
  "passengerDemand": 1.1,
  "cargoDemand": 0.92
 },
 {
  "id": "NSH",
  "name": "西浜",
  "countryId": "JP",
  "regionId": "west",
  "coordinates": {
   "latitude": 34.7,
   "longitude": 135.5
  },
  "distanceKm": 250,
  "passengerDemand": 0.75,
  "cargoDemand": 0.7
 },
 {
  "id": "HSM",
  "name": "星見",
  "countryId": "JP",
  "regionId": "east",
  "coordinates": {
   "latitude": 38.3,
   "longitude": 140.9
  },
  "distanceKm": 2500,
  "passengerDemand": 1.05,
  "cargoDemand": 0.98
 },
 {
  "id": "TYO",
  "name": "東京",
  "countryId": "JP",
  "regionId": "east",
  "coordinates": {
   "latitude": 35.68,
   "longitude": 139.69
  },
  "distanceKm": 760,
  "passengerDemand": 1.25,
  "cargoDemand": 1.2,
  "minimumAirportRating": 55
 },
 {
  "id": "OSA",
  "name": "大阪",
  "countryId": "JP",
  "regionId": "west",
  "coordinates": {
   "latitude": 34.69,
   "longitude": 135.5
  },
  "distanceKm": 520,
  "passengerDemand": 1.18,
  "cargoDemand": 1.15,
  "minimumAirportRating": 55
 },
 {
  "id": "SPK",
  "name": "札幌",
  "countryId": "JP",
  "regionId": "north",
  "coordinates": {
   "latitude": 43.06,
   "longitude": 141.35
  },
  "distanceKm": 830,
  "passengerDemand": 1.08,
  "cargoDemand": 0.94,
  "minimumAirportRating": 55
 },
 {
  "id": "FUK",
  "name": "福岡",
  "countryId": "JP",
  "regionId": "west",
  "coordinates": {
   "latitude": 33.59,
   "longitude": 130.4
  },
  "distanceKm": 880,
  "passengerDemand": 1.06,
  "cargoDemand": 0.9,
  "minimumAirportRating": 55
 },
 {
  "id": "OKA",
  "name": "那覇",
  "countryId": "JP",
  "regionId": "south",
  "coordinates": {
   "latitude": 26.21,
   "longitude": 127.68
  },
  "distanceKm": 1550,
  "passengerDemand": 0.98,
  "cargoDemand": 0.84,
  "minimumAirportRating": 55
 },
 {
  "id": "SEL",
  "name": "ソウル",
  "countryId": "KR",
  "regionId": "east-asia",
  "coordinates": {
   "latitude": 37.57,
   "longitude": 126.98
  },
  "distanceKm": 1160,
  "passengerDemand": 1.08,
  "cargoDemand": 1.16,
  "minimumAirportRating": 70
 },
 {
  "id": "TPE",
  "name": "台北",
  "countryId": "TW",
  "regionId": "east-asia",
  "coordinates": {
   "latitude": 25.03,
   "longitude": 121.56
  },
  "distanceKm": 2200,
  "passengerDemand": 1.12,
  "cargoDemand": 1.2,
  "minimumAirportRating": 70
 },
 {
  "id": "HKG",
  "name": "香港",
  "countryId": "HK",
  "regionId": "east-asia",
  "coordinates": {
   "latitude": 22.31,
   "longitude": 114.17
  },
  "distanceKm": 2900,
  "passengerDemand": 1.18,
  "cargoDemand": 1.42,
  "minimumAirportRating": 75
 },
 {
  "id": "SIN",
  "name": "シンガポール",
  "countryId": "SG",
  "regionId": "southeast-asia",
  "coordinates": {
   "latitude": 1.35,
   "longitude": 103.82
  },
  "distanceKm": 5300,
  "passengerDemand": 1.15,
  "cargoDemand": 1.48,
  "minimumAirportRating": 80
 },
 {
  "id": "BKK",
  "name": "バンコク",
  "countryId": "TH",
  "regionId": "southeast-asia",
  "coordinates": {
   "latitude": 13.76,
   "longitude": 100.5
  },
  "distanceKm": 4600,
  "passengerDemand": 1.1,
  "cargoDemand": 1.25,
  "minimumAirportRating": 75
 },
 {
  "id": "NDB",
  "name": "ノルデンブルク",
  "countryId": "ND",
  "regionId": "north-continent",
  "coordinates": {
   "latitude": 54.2,
   "longitude": 12.4
  },
  "distanceKm": 7200,
  "passengerDemand": 0.9,
  "cargoDemand": 1.05,
  "minimumAirportRating": 85
 },
 {
  "id": "BNH",
  "name": "ベルンハイム",
  "countryId": "BH",
  "regionId": "central-continent",
  "coordinates": {
   "latitude": 47.8,
   "longitude": 8.2
  },
  "distanceKm": 8900,
  "passengerDemand": 0.92,
  "cargoDemand": 1.1,
  "minimumAirportRating": 85
 },
 {
  "id": "LUM",
  "name": "ルミナス",
  "countryId": "LM",
  "regionId": "south-continent",
  "coordinates": {
   "latitude": -9.4,
   "longitude": 35.1
  },
  "distanceKm": 10500,
  "passengerDemand": 0.88,
  "cargoDemand": 1.18,
  "minimumAirportRating": 90
 }
] as const;
const LEGACY_COUNTRIES = [
 {
  "id": "JP",
  "name": "日本",
  "regionId": "east-asia"
 },
 {
  "id": "KR",
  "name": "韓国",
  "regionId": "east-asia"
 },
 {
  "id": "TW",
  "name": "台湾",
  "regionId": "east-asia"
 },
 {
  "id": "HK",
  "name": "香港",
  "regionId": "east-asia"
 },
 {
  "id": "SG",
  "name": "シンガポール",
  "regionId": "southeast-asia"
 },
 {
  "id": "TH",
  "name": "タイ",
  "regionId": "southeast-asia"
 },
 {
  "id": "ND",
  "name": "ノルデンブルク",
  "regionId": "north-continent"
 },
 {
  "id": "BH",
  "name": "ベルンハイム",
  "regionId": "central-continent"
 },
 {
  "id": "LM",
  "name": "ルミナス",
  "regionId": "south-continent"
 }
] as const;
const LEGACY_REGIONS = [
 {
  "id": "east-asia",
  "name": "東アジア"
 },
 {
  "id": "southeast-asia",
  "name": "東南アジア"
 },
 {
  "id": "north-continent",
  "name": "北方大陸"
 },
 {
  "id": "central-continent",
  "name": "中央大陸"
 },
 {
  "id": "south-continent",
  "name": "南方大陸"
 },
 {
  "id": "north",
  "name": "北部"
 },
 {
  "id": "east",
  "name": "東部"
 },
 {
  "id": "south",
  "name": "南部"
 },
 {
  "id": "west",
  "name": "西部"
 },
 {
  "id": "central",
  "name": "中央部"
 }
] as const;

const pickA = (a: (typeof AIRLINES)[number]) => {
  const { id, code, name, type, fleet, priceSensitivity, minOtp, minimumAirportRating, services } = a;
  return { id, code, name, type, fleet: fleet.map((f) => ({ typeId: f.typeId, seats: f.seats })), priceSensitivity, minOtp, ...(minimumAirportRating !== undefined ? { minimumAirportRating } : {}), services: [...services] };
};
const pickD = (d: (typeof DESTINATIONS)[number]) => {
  const { id, name, countryId, regionId, coordinates, distanceKm, passengerDemand, cargoDemand, minimumAirportRating } = d;
  return { id, name, countryId, regionId, coordinates: { ...coordinates }, distanceKm, passengerDemand, cargoDemand, ...(minimumAirportRating !== undefined ? { minimumAirportRating } : {}) };
};

describe('catalogLegacy: 旧データの固定（フェーズ 3 回帰）', () => {
  it('航空会社 8 社が順序・値とも旧 registry と一致する', () => {
    expect(AIRLINES.slice(0, LEGACY_AIRLINES.length).map(pickA)).toEqual(LEGACY_AIRLINES);
    expect(AIRLINES.slice(0, LEGACY_AIRLINES.length).every((a) => a.legacy)).toBe(true);
  });
  it('就航都市 21 都市が順序・値とも旧 registry と一致する', () => {
    expect(DESTINATIONS.slice(0, LEGACY_DESTINATIONS.length).map(pickD)).toEqual(LEGACY_DESTINATIONS);
    expect(DESTINATIONS.slice(0, LEGACY_DESTINATIONS.length).every((d) => d.legacy)).toBe(true);
  });
  it('国 9 件・地域 10 件が旧 registry と一致する（先頭部分）', () => {
    expect(COUNTRIES.slice(0, LEGACY_COUNTRIES.length)).toEqual(LEGACY_COUNTRIES);
    expect(REGIONS.slice(0, LEGACY_REGIONS.length)).toEqual(LEGACY_REGIONS);
  });
});
