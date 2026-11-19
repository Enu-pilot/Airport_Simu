import type { AtcScenarioDefinition, AtcSessionState } from './types';
import { ATC_SAVE_FORMAT_VERSION, ATC_SESSION_FILE_KIND } from './types';

/**
 * ATC-10 基盤: ATC専用セーブ形式。
 * 経営モードの ProjectFile とは形式・検証を完全に分ける。経営側の
 * SAVE_FORMAT / PROJECT_FORMAT_VERSION には一切触れない。
 * ストレージ（IndexedDB skyport-atc）への接続は UI 接続時（ATC-08/10）に
 * 本モジュールの入出力を使う。
 */

export interface AtcSessionFile {
  kind: typeof ATC_SESSION_FILE_KIND;
  formatVersion: number;
  modelVersion: string;
  scenario: AtcScenarioDefinition;
  session: AtcSessionState;
}

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function serializeAtcSession(
  scenario: AtcScenarioDefinition,
  session: AtcSessionState,
): AtcSessionFile {
  return {
    kind: ATC_SESSION_FILE_KIND,
    formatVersion: ATC_SAVE_FORMAT_VERSION,
    modelVersion: session.modelVersion,
    scenario: deepClone(scenario),
    session: deepClone(session),
  };
}

export type ParseAtcSessionResult =
  | { ok: true; file: AtcSessionFile }
  | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 検証付き読み込み。不正な入力では既存セッションを変更しない（純関数）。
 * 経営モードの ProjectFile を渡した場合は明示的に拒否する。
 */
export function parseAtcSessionFile(input: unknown): ParseAtcSessionResult {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, errors: ['not-json'] };
    }
  }
  if (!isRecord(value)) return { ok: false, errors: ['not-an-object'] };
  if (value.kind !== ATC_SESSION_FILE_KIND) {
    // 経営 ProjectFile らしい形（layout/company を持つ）は誤投入として区別する
    if ('layout' in value || 'company' in value) return { ok: false, errors: ['management-project-file'] };
    return { ok: false, errors: ['unknown-kind'] };
  }
  if (value.formatVersion !== ATC_SAVE_FORMAT_VERSION) {
    return { ok: false, errors: ['unsupported-format-version'] };
  }
  const errors: string[] = [];
  const scenario = value.scenario;
  const session = value.session;
  if (!isRecord(scenario) || typeof scenario.id !== 'string' || !isRecord(scenario.airport)) {
    errors.push('invalid-scenario');
  }
  if (!isRecord(session) || typeof session.clockSec !== 'number' || !isRecord(session.aircraft)) {
    errors.push('invalid-session');
  }
  if (errors.length > 0) return { ok: false, errors };

  const file = value as unknown as AtcSessionFile;
  if (file.session.scenarioId !== file.scenario.id) errors.push('scenario-id-mismatch');
  // 参照整合性: 航空機の runway/stand がスナップショット内に存在すること
  const layout = file.scenario.airport.layout;
  for (const aircraft of Object.values(file.session.aircraft)) {
    if (!layout.runways[aircraft.runwayId]) errors.push(`unknown-runway:${aircraft.id}`);
    if (!layout.stands[aircraft.standId]) errors.push(`unknown-stand:${aircraft.id}`);
  }
  for (const request of Object.values(file.session.requests)) {
    if (!file.session.aircraft[request.aircraftId]) errors.push(`unknown-request-aircraft:${request.id}`);
  }
  for (const clearance of Object.values(file.session.clearances)) {
    if (!file.session.aircraft[clearance.aircraftId]) errors.push(`unknown-clearance-aircraft:${clearance.id}`);
    if (!file.session.requests[clearance.requestId]) errors.push(`unknown-clearance-request:${clearance.id}`);
  }
  // 到着順序（ATC-07）: あれば航空機IDの配列であること。不在は未指定として扱う
  const sequence = (file.session as { arrivalSequence?: unknown }).arrivalSequence;
  if (
    sequence !== undefined &&
    (!Array.isArray(sequence) || sequence.some((id) => typeof id !== 'string'))
  ) {
    errors.push('invalid-arrival-sequence');
  }
  if (errors.length > 0) return { ok: false, errors };
  const cloned = deepClone(file);
  // 旧ファイル互換: 追加フィールドが無い場合は既定値で補う（意味は変えない）
  if (cloned.session.arrivalSequence === undefined) cloned.session.arrivalSequence = [];
  for (const aircraft of Object.values(cloned.session.aircraft)) {
    if (aircraft.goAroundCount === undefined) aircraft.goAroundCount = 0;
  }
  return { ok: true, file: cloned };
}
