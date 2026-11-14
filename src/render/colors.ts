import type { FacilityKind, SizeClass, TerrainType } from '../core/model/types';
import type { AirsideNodeKind } from '../core/airside/network';
import type { Severity } from '../core/validation/validate';

export const TERRAIN_COLOR: Record<TerrainType, [number, number, number]> = {
  0: [86, 112, 64], // 草地
  1: [52, 82, 46], // 森
  2: [44, 92, 138], // 水域
  3: [110, 106, 100], // 岩場
  4: [38, 40, 42], // 敷地外
};

export const FACILITY_COLOR: Record<FacilityKind, number> = {
  apron: 0x75787c,
  terminal: 0xb7c3cf,
  gate: 0xe8b23a,
  hangar: 0x8d99a6,
  tower: 0xd2694a,
  maintenance: 0x9583b0,
  fuelFarm: 0xcaa52b,
  fireStation: 0xc8443a,
  gseBase: 0x4f9494,
  baggageSort: 0x6b8f4f,
  serviceArea: 0x857b5e,
  parking: 0x5d6673,
  taxiStand: 0xf2c230,
  busStop: 0x3d8fd6,
  railStation: 0x9c5fbf,
  staffParking: 0x4d5560,
  hotel: 0xc98a5c,
};

export const SIZE_COLOR: Record<SizeClass, number> = { S: 0x66bb6a, M: 0x42a5f5, L: 0xba68c8 };

export const NODE_COLOR: Record<AirsideNodeKind, number> = {
  taxiway: 0xb0b0b0,
  intersection: 0xffffff,
  endpoint: 0xffa726,
  runwayEntry: 0xff5252,
  runwayThreshold: 0xffffff,
  runwayIntersection: 0xff9800,
  stand: 0x80deea,
};

export const SEVERITY_COLOR: Record<Severity, number> = { error: 0xff4d4f, warning: 0xffb020, info: 0x4fa3ff };

export const COLOR = {
  background: 0x1b1f24,
  grid: 0x000000,
  gridMajor: 0x000000,
  runway: 0x34363a,
  runwayMarking: 0xf2f2f2,
  strip: 0xffffff,
  runwayShoulder: 0x555a60,
  resa: 0xffb74d,
  taxiway: 0x55585c,
  taxiwayEdge: 0x6d7175,
  taxiCenter: 0xf4d03f,
  roadPublic: 0x2e3135,
  roadService: 0x7a6a48,
  rail: 0x6e5a7e,
  walkway: 0x39a9a1,
  fuelPipe: 0xcaa52b,
  roadMarking: 0xdedede,
  selection: 0x3ff0ff,
  ghostOk: 0x5cff8d,
  ghostBad: 0xff4d4f,
  construction: 0xff9f1c,
  planned: 0xffffff,
  standLine: 0xf5f5f5,
  connected: 0x5cff8d,
  disconnected: 0xff4d4f,
  holdShort: 0xffd400,
  unbuildable: 0xff3030,
} as const;
