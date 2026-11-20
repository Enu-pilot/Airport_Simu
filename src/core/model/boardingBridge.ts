import { DOOR_SILL_M, DOOR_SILL_UPPER_M, PBB_TYPES, type PbbBridgeType, type PbbDeck } from './catalog';
import { gateMode } from './gates';
import { facilityLevel } from './levels';
import { sortedValues } from './ids';
import type { AirportLayout, BuildState, Facility, SizeClass } from './types';

/**
 * 搭乗橋（PBB、機能H）の読み取り層。設計は design-GHIJ-detail.md §H が正本。
 *
 * ゲート（ターミナル側の搭乗管理ノード）と PBB（機体ドアへつなぐ物理設備）を分離し、
 * PBB は新施設種別 'boardingBridge' としてゲートに紐付ける。props はここを通して読む。
 *
 * 互換（ユーザーの言う「既存ゲートは全部 PBB に置き換わる」）: 明示の PBB が無い
 * コンタクトゲートは、jetBridge が有効なら tunnel1 相当の橋 1 基を「合成」して返す。
 * 合成は読み取り時に導出するだけで、保存データには書かない（セーブ形式・
 * SCHEMA_VERSION を変えず、旧アプリでも従来どおり読める）。プレイヤーが明示の
 * PBB を置いた時点で、そのゲートは実データとして PBB を持ち、ファイルは
 * formatVersion 9 を名乗る。合成 tunnel1 の速度は従来定数と一致するため、
 * 明示 PBB の無いレイアウトの運航結果は従来と変わらない。
 */

/** 橋が無いときの搭乗速度（秒/人。タラップ/徒歩。sim/passengers の従来定数 stairs と一致） */
export const STAIRS_BOARD_SEC_PER_PAX = 5;
/** 橋が無いときの降機速度（人/分。同 stairs） */
export const STAIRS_DEPLANE_PER_MIN = 12;

/**
 * ドアシル高が型式の適合範囲を超えたときの速度ペナルティ（ゲーム値）。
 * ユーザー指定の落としどころ: 1本（tunnel1）でも大型機（シル高 4.7m > 上限 4.6m）は
 * 運用できるが、ドア高が合わず作業が遅れる。2本（tunnel2 系、上限 5.4m）で
 * ペナルティなく真価を発揮する。ペナルティは明示配置した PBB にだけ適用し、
 * 互換合成の橋は従来どおり（等価性 = ゴールデン不変のため）。
 */
export const PBB_SILL_OVER_BOARD_SEC_PER_PAX = 4.0;
export const PBB_SILL_OVER_DEPLANE_PER_MIN = 16;

/** PBB の配置可能範囲: 紐付くスポットの入口（standEntry）からのチェビシェフ距離（タイル。ゲーム値） */
export const PBB_ENTRY_RANGE = 2;

/** ゲートに紐付く PBB 1 基の読み取り結果 */
export interface PbbInfo {
  /** 明示の PBB 施設の ID。互換合成のときは null */
  facilityId: string | null;
  bridgeType: PbbBridgeType;
  deck: PbbDeck;
  /** 互換合成（従来の jetBridge から導出した tunnel1 相当）かどうか */
  synthesized: boolean;
  buildState: BuildState;
}

/** PBB 施設の型式（欠落・不正値は 'tunnel1' = 従来の橋） */
export function pbbTypeOf(f: Facility): PbbBridgeType {
  const t = f.kind === 'boardingBridge' ? f.props.bridgeType : undefined;
  return typeof t === 'string' && t in PBB_TYPES ? (t as PbbBridgeType) : 'tunnel1';
}

/** PBB 施設のデッキ（欠落・不正値は 'main'） */
export function pbbDeckOf(f: Facility): PbbDeck {
  return f.kind === 'boardingBridge' && f.props.deck === 'upper' ? 'upper' : 'main';
}

/** PBB 施設が指すゲート ID（文字列でなければ null） */
export function pbbGateIdOf(f: Facility): string | null {
  const id = f.kind === 'boardingBridge' ? f.props.gateId : undefined;
  return typeof id === 'string' ? id : null;
}

/** PBB 施設が指すスポット ID（文字列でなければ null） */
export function pbbStandIdOf(f: Facility): string | null {
  const id = f.kind === 'boardingBridge' ? f.props.standId : undefined;
  return typeof id === 'string' ? id : null;
}

// 明示 PBB の一覧はレイアウト単位でメモ化する（sim の毎 tick 参照に耐えるため。
// レイアウトは不変オブジェクトとして扱われ、編集のたびに新しい参照になる）
const explicitCache = new WeakMap<AirportLayout, Map<string, PbbInfo[]>>();

/** ゲートに紐付く明示の PBB（ID 順で決定的）。合成は含まない */
export function explicitPbbForGate(layout: AirportLayout, gateId: string): PbbInfo[] {
  let byGate = explicitCache.get(layout);
  if (!byGate) {
    byGate = new Map();
    for (const f of sortedValues(layout.facilities)) {
      if (f.kind !== 'boardingBridge') continue;
      const gid = pbbGateIdOf(f);
      if (gid === null) continue;
      const info: PbbInfo = {
        facilityId: f.id,
        bridgeType: pbbTypeOf(f),
        deck: pbbDeckOf(f),
        synthesized: false,
        buildState: f.buildState,
      };
      const list = byGate.get(gid);
      if (list) list.push(info);
      else byGate.set(gid, [info]);
    }
    explicitCache.set(layout, byGate);
  }
  return byGate.get(gateId) ?? [];
}

/** ゲートに明示の PBB があるか */
export function hasExplicitPbb(layout: AirportLayout, gateId: string): boolean {
  return explicitPbbForGate(layout, gateId).length > 0;
}

/**
 * ゲートの PBB（読み取りの正）: 明示の PBB が 1 基でもあればそれを正とし、
 * ゲートの props.jetBridge は無視する。無ければ互換合成:
 * コンタクト方式かつ jetBridge が有効なゲートに tunnel1 相当（main）を 1 基合成する。
 * バスゲート・jetBridge 無効のゲートには合成しない。
 */
export function pbbForGate(layout: AirportLayout, gateId: string): PbbInfo[] {
  const explicit = explicitPbbForGate(layout, gateId);
  if (explicit.length > 0) return explicit;
  const gate = layout.facilities[gateId];
  if (!gate || gate.kind !== 'gate') return [];
  if (gateMode(gate) !== 'contact' || !gate.props.jetBridge) return [];
  return [{ facilityId: null, bridgeType: 'tunnel1', deck: 'main', synthesized: true, buildState: 'operational' }];
}

/** ゲートの実効地図階層（建物内ゲートは親の階層 + 建物内階。validation の GATE_UNDERGROUND_BRIDGE と同じ式） */
export function gateEffectiveLevel(layout: AirportLayout, gate: Facility): number {
  const parent = gate.parentFacilityId ? layout.facilities[gate.parentFacilityId] : undefined;
  return parent ? facilityLevel(parent) + (gate.floorIndex ?? 0) : facilityLevel(gate);
}

/** 搭乗プロファイルの対象機体（ドア判定に要る最小限の情報） */
export interface PbbAircraftInfo {
  size: SizeClass;
  doubleDeck: boolean;
}

export type BoardingProfileReason =
  /** バスゲート（橋は使わない） */
  | 'bus'
  /** 橋が無い（jetBridge 無効・明示 PBB なし） */
  | 'noBridge'
  /** 明示 PBB はあるが全て建設中・計画中 */
  | 'notOperational'
  /** 地下の搭乗口（G-U4: sim では橋なし扱い） */
  | 'underground'
  /** 主デッキの橋が無く、上デッキの橋だけがある */
  | 'noMainDeck';

export interface BoardingProfile {
  /** 橋を使って搭乗/降機するか（false ならタラップ値） */
  usesBridge: boolean;
  /** 橋の出所: 明示配置 / 互換合成 / なし */
  source: 'explicit' | 'legacy' | 'none';
  /** 搭乗速度（秒/人。並行デッキは合成済み。橋なしはタラップ値） */
  boardSecPerPax: number;
  /** 降機速度（人/分。同上） */
  deplanePerMin: number;
  /** 実際に使うデッキ（doubleDeck 機で upper 橋があるとき ['main', 'upper']） */
  decks: PbbDeck[];
  /** ドアシル高が型式の範囲を超えて速度ペナルティが掛かったか（明示 PBB のみ） */
  sillOver: boolean;
  /** 橋が使えない理由（usesBridge = false のとき） */
  reason?: BoardingProfileReason;
}

const noBridge = (source: BoardingProfile['source'], reason: BoardingProfileReason): BoardingProfile => ({
  usesBridge: false,
  source,
  boardSecPerPax: STAIRS_BOARD_SEC_PER_PAX,
  deplanePerMin: STAIRS_DEPLANE_PER_MIN,
  decks: [],
  sillOver: false,
  reason,
});

/**
 * ゲート×機体の搭乗プロファイル（純関数）。sim・検証・UI が共通で使う。
 * - 主デッキ: 紐付くスポットに停まる機体のドアは主デッキ側。upper の橋は
 *   doubleDeck 機のときだけ第 2 系統として並行に効く（合計速度 = 両デッキの和）
 * - 地下の搭乗口では橋は使えない（G-U4 の確定。地上の従来レイアウトには影響しない）
 * - 互換合成の橋はシル高ペナルティの対象外（従来の橋は従来どおり）
 */
export function boardingProfile(layout: AirportLayout, gateId: string | null, aircraft: PbbAircraftInfo): BoardingProfile {
  const gate = gateId ? layout.facilities[gateId] : undefined;
  if (!gate || gate.kind !== 'gate') return noBridge('none', 'noBridge');
  if (gateMode(gate) === 'bus') return noBridge('none', 'bus');
  const units = pbbForGate(layout, gate.id);
  if (units.length === 0) return noBridge('none', 'noBridge');
  const source: BoardingProfile['source'] = units[0]!.synthesized ? 'legacy' : 'explicit';
  const active = units.filter((u) => u.buildState === 'operational');
  if (active.length === 0) return noBridge(source, 'notOperational');
  if (gateEffectiveLevel(layout, gate) < 0) return noBridge(source, 'underground');

  const streams: { boardSecPerPax: number; deplanePerMin: number }[] = [];
  const decks: PbbDeck[] = [];
  let sillOver = false;
  const main = active.find((u) => u.deck === 'main');
  // 主デッキの橋が無ければ（上デッキだけでは）搭乗できない
  if (!main) return noBridge(source, 'noMainDeck');
  {
    const spec = PBB_TYPES[main.bridgeType];
    const sill = DOOR_SILL_M[aircraft.size];
    if (!main.synthesized && sill > spec.sillMain.max) {
      sillOver = true;
      streams.push({ boardSecPerPax: PBB_SILL_OVER_BOARD_SEC_PER_PAX, deplanePerMin: PBB_SILL_OVER_DEPLANE_PER_MIN });
    } else {
      streams.push({ boardSecPerPax: spec.boardSecPerPax.main, deplanePerMin: spec.deplanePerMin.main });
    }
    decks.push('main');
  }
  const upper = active.find((u) => u.deck === 'upper');
  if (upper && aircraft.doubleDeck) {
    const spec = PBB_TYPES[upper.bridgeType];
    if (spec.sillUpper && spec.boardSecPerPax.upper !== undefined && spec.deplanePerMin.upper !== undefined) {
      if (!upper.synthesized && DOOR_SILL_UPPER_M > spec.sillUpper.max) {
        sillOver = true;
        streams.push({ boardSecPerPax: PBB_SILL_OVER_BOARD_SEC_PER_PAX, deplanePerMin: PBB_SILL_OVER_DEPLANE_PER_MIN });
      } else {
        streams.push({ boardSecPerPax: spec.boardSecPerPax.upper, deplanePerMin: spec.deplanePerMin.upper });
      }
      decks.push('upper');
    }
  }
  if (streams.length === 0) return noBridge(source, 'noMainDeck');
  // 並行系統の合成: 搭乗は「人/秒」の和、降機は「人/分」の和
  const boardSecPerPax = 1 / streams.reduce((sum, s) => sum + 1 / s.boardSecPerPax, 0);
  const deplanePerMin = streams.reduce((sum, s) => sum + s.deplanePerMin, 0);
  return { usesBridge: true, source, boardSecPerPax, deplanePerMin, decks, sillOver };
}
