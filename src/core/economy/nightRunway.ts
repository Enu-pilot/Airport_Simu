import { isFreeRunway, type AirportLayout, type Runway } from '../model/types';
import type { CityProtectionSector } from './city';

/**
 * 方向別の夜間運航許可（5-24 の核）。
 *
 * 既定は全面カーフュー（従来どおり）で、この関数は「どの滑走路端・方向なら
 * 都市上空を避けて夜間に使えるか」の判定だけを行う。実際の運航への適用は別途。
 *
 * 考え方: 滑走路端ごとに、離陸方向（その端から出発し、反対端の先へ伸びる経路）と
 * 着陸の進入方向（その端へ向かう進入経路が空港の外へ伸びる方位）が決まる。
 * その方位が都市の保護区域（方位範囲）に触れなければ、その方向は夜間許可候補になる。
 */

const norm = (deg: number): number => ((deg % 360) + 360) % 360;

/** 方位が保護区域に入るか。fromDeg > toDeg の範囲は 0 度を跨ぐ */
export function bearingInSector(bearingDeg: number, sector: CityProtectionSector): boolean {
  const b = norm(bearingDeg);
  const from = norm(sector.fromDeg);
  const to = norm(sector.toDeg);
  return from <= to ? b >= from && b <= to : b >= from || b <= to;
}

export function bearingProtected(bearingDeg: number, sectors: readonly CityProtectionSector[]): boolean {
  return sectors.some((s) => bearingInSector(bearingDeg, s));
}

/** 滑走路の進行方位（真方位）。従来形は heading、自由形は headingDeg */
export function runwayBearing(runway: Runway): number {
  return isFreeRunway(runway) ? norm(runway.headingDeg) : norm(runway.heading);
}

export interface RunwayEndNightPermission {
  runwayId: string;
  /** 'start' = 始点側の端、'far' = 終点側の端 */
  end: 'start' | 'far';
  /** この端から離陸する方向（真方位） */
  departureBearing: number;
  /** この端へ着陸する進入経路が外へ伸びる方位（真方位） */
  arrivalBearing: number;
  departureAllowed: boolean;
  arrivalAllowed: boolean;
}

/** 全滑走路端について、保護区域を避けられる方向を判定する。保護区域がなければ全方向が候補 */
export function nightEndPermissions(layout: AirportLayout, sectors: readonly CityProtectionSector[]): RunwayEndNightPermission[] {
  const out: RunwayEndNightPermission[] = [];
  for (const r of Object.values(layout.runways)) {
    if (r.buildState !== 'operational') continue;
    const h = runwayBearing(r);
    const opp = norm(h + 180);
    out.push({
      runwayId: r.id,
      end: 'start',
      departureBearing: h,
      arrivalBearing: opp,
      departureAllowed: !bearingProtected(h, sectors),
      arrivalAllowed: !bearingProtected(opp, sectors),
    });
    out.push({
      runwayId: r.id,
      end: 'far',
      departureBearing: opp,
      arrivalBearing: h,
      departureAllowed: !bearingProtected(opp, sectors),
      arrivalAllowed: !bearingProtected(h, sectors),
    });
  }
  return out;
}

/** 夜間に少なくとも 1 方向でも使える滑走路端があるか */
export function anyNightPermission(layout: AirportLayout, sectors: readonly CityProtectionSector[]): boolean {
  return nightEndPermissions(layout, sectors).some((p) => p.departureAllowed || p.arrivalAllowed);
}
