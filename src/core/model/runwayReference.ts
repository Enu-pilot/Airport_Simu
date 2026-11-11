import type { DataSource, Sourced } from '../aircraft/catalog';
import type { RunwayDims } from './types';

/**
 * 滑走路の実寸の参考値とゲーム既定値（Phase 12 S3）。
 *
 * 2 つの表を分ける:
 * - 参考値の表（RUNWAY_REFERENCE）: 公開資料（research/runway_reference.md）の値を出典つきで転記しただけ。判定には使わない。
 * - ゲーム既定値の表（FREE_RUNWAY_DEFAULTS）: 自由形の滑走路の判定・描画に使うゲーム値。採用元の参考値を
 *   FREE_RUNWAY_DEFAULT_BASIS で示す。資料で確認できなかった項目（NOT FOUND）はゲーム値・ゲームの規則として明記する。
 *
 * これらは参考値であり、実際の安全基準への適合を保証しない（RUNWAY_REFERENCE_DISCLAIMER。UI と docs に必ず添える）。
 * FAA の値は参考値の表にだけ載せ、既定値には使わない（ICAO 系の EASA に統一）。
 */

export const RUNWAY_REFERENCE_DISCLAIMER = '参考値。ゲーム内の判定であり、実際の安全基準への適合を保証しません';

/** 出典（accessed はすべて 2026-11-11）。キーは Sourced.source と FREE_RUNWAY_DEFAULT_BASIS.source が参照する */
export const RUNWAY_REF_SOURCES: Record<string, DataSource> = {
  'faa-ac-150-5300-13b-chg1': {
    id: 'faa-ac-150-5300-13b-chg1',
    publisher: 'FAA',
    title: 'AC 150/5300-13B Airport Design, consolidated with Change 1 (16 Aug 2024; Appendix G Tables G-1 to G-12, para 3.9)',
    url: 'https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC-150-5300-13B-Airport-Design-Chg1-w-errata.pdf',
    accessed: '2026-11-11',
  },
  'faa-aim-2-3-3': {
    id: 'faa-aim-2-3-3',
    publisher: 'FAA',
    title: 'Aeronautical Information Manual, Chapter 2 Section 3, para 2-3-3 Runway Markings (Runway Designators)',
    url: 'https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap2_section_3.html',
    accessed: '2026-11-11',
  },
  'easa-cs-adr-dsn-i5': {
    id: 'easa-cs-adr-dsn-i5',
    publisher: 'EASA',
    title: 'CS-ADR-DSN Issue 5 (16 Jun 2025): B.045, B.050, B.055, B.125, B.135, B.155, B.160, C.215, D.340 Table D-2, L.525',
    url: 'https://www.easa.europa.eu/en/downloads/125398/en',
    accessed: '2026-11-11',
  },
};

const ref = (value: number, source: string, note: string): Sourced<number> => ({ value, status: 'official', source, note });
const EASA = 'easa-cs-adr-dsn-i5';
const FAA = 'faa-ac-150-5300-13b-chg1';

/** 参考値（m。倍率は無次元）。判定には使わない。キーは `<出典>.<項目>` */
export const RUNWAY_REFERENCE: Record<string, Sourced<number>> = {
  'easa.strip.endM': ref(60, EASA, 'CS B.155: 着陸帯の端部延長（滑走路端から）。計器滑走路・コード 1〜4'),
  'easa.strip.halfWidthM.code34': ref(140, EASA, 'CS B.160(a)(b): 精密・非精密進入滑走路の着陸帯の半幅（中心線から片側）。コード番号 3〜4'),
  'easa.resa.minLengthM': ref(90, EASA, 'CS C.215(a): RESA の最小長さ（着陸帯の端から外側へ）。コード番号 3〜4'),
  'easa.resa.practicableLengthM.code34': ref(240, EASA, 'CS C.215(a): 可能な限り確保する RESA の長さ。コード番号 3〜4'),
  'easa.resa.widthFactor': ref(2, EASA, 'CS C.215(c): RESA の幅は滑走路幅の 2 倍以上（倍率）'),
  'easa.holding.precisionCat1.code34M': ref(90, EASA, 'Table D-2: 精密進入 CAT I・コード番号 3〜4 の停止位置（中心線から）'),
  'easa.holding.precisionCat1.codeFM': ref(107.5, EASA, 'Table D-2: 精密進入 CAT I・コード番号 4・コード文字 F の停止位置（中心線から）'),
  'easa.shoulder.totalWidthM.codeDE': ref(60, EASA, 'CS B.135(a): コード文字 D・E の滑走路と肩の全幅。肩が必要なのは D/E/F（B.125(b)）'),
  'easa.shoulder.totalWidthM.codeF.2or3Engines': ref(60, EASA, 'CS B.135(b): コード文字 F（2・3 発）の全幅'),
  'easa.shoulder.totalWidthM.codeF.4Engines': ref(75, EASA, 'CS B.135(c): コード文字 F（4 発以上）の全幅'),
  'easa.width.code3.omgws9to15M': ref(45, EASA, 'Table B-1: コード番号 3、OMGWS 9〜15 m 未満の滑走路幅'),
  'easa.width.code3.omgwsUnder9M': ref(30, EASA, 'Table B-1: コード番号 3、OMGWS 9 m 未満の滑走路幅'),
  'easa.parallel.nonInstrument.code34M': ref(210, EASA, 'CS B.050: 非計器の平行滑走路を同時使用するときの中心線間隔の最小。コード番号 3〜4'),
  'easa.parallel.independentApproachM': ref(1035, EASA, 'CS B.055: 独立した平行進入の中心線間隔'),
  'easa.parallel.dependentApproachM': ref(915, EASA, 'CS B.055: 従属した平行進入の中心線間隔'),
  'easa.parallel.independentDepartureM': ref(760, EASA, 'CS B.055: 独立した平行出発の中心線間隔'),
  'faa.parallel.vfrSimultaneousM': ref(213.4, FAA, 'para 3.9.2: VFR 同時の離着陸 700 ft（213 m）'),
  'faa.parallel.ifrApproachHighUpdateM': ref(975.4, FAA, 'para 3.9.3: IFR 同時進入（高頻度更新の監視あり、直線進入）3,200 ft'),
  'faa.parallel.ifrDepartureM': ref(762, FAA, 'para 3.9.4: 同時出発（進路の発散あり）2,500 ft'),
  'faa.rsa.lengthBeyondDepartureM.cdeIV': ref(304.8, FAA, 'Table G-10（C/D/E-IV、Visual）: RSA の長さ 1,000 ft'),
  'faa.rsa.widthM.cdeIV': ref(152.4, FAA, 'Table G-10（C/D/E-IV、Visual）: RSA の幅 500 ft'),
  'faa.shoulderM.cdeIV': ref(7.6, FAA, 'Table G-10（C/D/E-IV）: 肩 25 ft'),
  'faa.holding.cdeIVM': ref(76.2, FAA, 'Table G-10（C/D/E-IV、Visual）: 停止位置 250 ft'),
};

/** ゲーム既定値の項目（RunwayDims のうち標高を除く） */
export type DefaultKey = 'shoulderWidthM' | 'stripHalfWidthM' | 'stripEndM' | 'resaLengthM' | 'resaWidthM' | 'holdingPositionM';
export type DefaultDims = Required<Pick<RunwayDims, DefaultKey>>;

/** 自由形の既定の実寸（m）。すべてゲーム値（採用元は FREE_RUNWAY_DEFAULT_BASIS）。幅は舗装幅 30/45/60 m ごと */
export const FREE_RUNWAY_DEFAULTS: Record<30 | 45 | 60, DefaultDims> = {
  30: { shoulderWidthM: 0, stripHalfWidthM: 140, stripEndM: 60, resaLengthM: 90, resaWidthM: 60, holdingPositionM: 90 },
  45: { shoulderWidthM: 7.5, stripHalfWidthM: 140, stripEndM: 60, resaLengthM: 90, resaWidthM: 90, holdingPositionM: 90 },
  60: { shoulderWidthM: 7.5, stripHalfWidthM: 140, stripEndM: 60, resaLengthM: 90, resaWidthM: 120, holdingPositionM: 107.5 },
};

export interface DefaultBasis {
  /** RUNWAY_REF_SOURCES のキー */
  source: string;
  /** RUNWAY_REFERENCE のキー（採用元の参考値） */
  refKeys: string[];
  /** どの参考値からどう決めたか。ゲーム値である旨を含む */
  note: string;
}

/** ゲーム既定値の採用元。判定の基準はあくまでゲーム値で、資料で確認できなかった仮定は note に明記する */
export const FREE_RUNWAY_DEFAULT_BASIS: Record<DefaultKey, DefaultBasis> = {
  shoulderWidthM: {
    source: EASA,
    refKeys: ['easa.shoulder.totalWidthM.codeDE', 'easa.shoulder.totalWidthM.codeF.2or3Engines', 'easa.shoulder.totalWidthM.codeF.4Engines'],
    note: 'ゲーム値。肩が必要なのは D/E/F（B.125(b)）。舗装幅 45 m は全幅 60 m（B.135(a)(b)）から片側 7.5 m、60 m は全幅 75 m（B.135(c)）から片側 7.5 m。30 m は肩なし（0）。コード文字ごとの幅の表は資料に無く（NOT FOUND）、幅とコード文字の対応はゲームの仮定',
  },
  stripHalfWidthM: {
    source: EASA,
    refKeys: ['easa.strip.halfWidthM.code34'],
    note: 'ゲーム値。コード番号 3〜4 の 140 m（B.160(a)(b)）を全幅で共通に採用。30 m 幅をコード番号 3 とみなすのもゲームの仮定',
  },
  stripEndM: { source: EASA, refKeys: ['easa.strip.endM'], note: 'ゲーム値。B.155 の 60 m を採用' },
  resaLengthM: { source: EASA, refKeys: ['easa.resa.minLengthM', 'easa.resa.practicableLengthM.code34'], note: 'ゲーム値。C.215(a) の最小 90 m を採用（可能な限りの 240 m は採らない）' },
  resaWidthM: { source: EASA, refKeys: ['easa.resa.widthFactor'], note: 'ゲーム値。C.215(c) の「滑走路幅の 2 倍以上」の最小値（舗装幅 × 2）を採用。60 m という舗装幅自体がゲーム値' },
  holdingPositionM: {
    source: EASA,
    refKeys: ['easa.holding.precisionCat1.code34M', 'easa.holding.precisionCat1.codeFM'],
    note: 'ゲーム値。Table D-2 の精密進入 CAT I・コード 3〜4 の 90 m を 30・45 m 幅に、コード文字 F の 107.5 m を 60 m 幅に採用（60 m 幅 = コード文字 F はゲームの仮定）',
  },
};

/** 勾配・標高の参考値は資料に無い（NOT FOUND）ので、Phase 12 は勾配の警告を作らず、表示（標高差 / 長さ）だけにする */
export const RUNWAY_SLOPE_REFERENCE = 'NOT FOUND' as const;
