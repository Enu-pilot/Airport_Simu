import { parseAtcSessionFile, serializeAtcSession, type AtcSessionFile } from './persistence';
import type { AtcScenarioDefinition, AtcSessionState } from './types';

/**
 * ATC-10 自動保存のコア側ヘルパー（純粋関数のみ）。
 *
 * エンジン本体の進行ロジックは変更せず、読み取りと persistence の
 * 呼び出しに留める。UI（ATC-08）は本モジュールの判定・スナップショット
 * 生成と src/atc/sessions.ts の専用ストアを組み合わせて自動保存を行う。
 * 自動保存データも通常保存と同じ検証（parseAtcSessionFile）を通す。
 */

/**
 * 自動保存の間隔（ゲーム秒）。管制の判断を妨げない頻度として置いた
 * ゲーム値であり、実測値ではない。UI 側で間隔を差し替える場合は
 * shouldAutosave / maybeAutosave の引数で渡す。
 */
export const ATC_AUTOSAVE_INTERVAL_SEC = 60;

/**
 * 自動保存すべきかどうかを、最後に保存した時点のセッション時計と
 * 現在の時計だけで決める純粋判定。
 * - 終了済みセッションは自動保存しない（終了保存は手動保存の責務）。
 * - 間隔 0 以下は自動保存の無効化として扱う。
 * - 時計が巻き戻っている（あり得ないが防御的に）場合は保存しない。
 */
export function shouldAutosave(
  session: AtcSessionState,
  lastSavedClockSec: number | null,
  intervalSec: number = ATC_AUTOSAVE_INTERVAL_SEC,
): boolean {
  if (intervalSec <= 0) return false;
  if (session.finished) return false;
  if (lastSavedClockSec === null) return session.clockSec >= intervalSec;
  return session.clockSec - lastSavedClockSec >= intervalSec;
}

/**
 * 保存対象スナップショットを生成する。serializeAtcSession の複製に
 * 通常保存と同じ検証を通し、検証済みのファイルだけを返す。
 * 検証に失敗する状態は自動保存の対象にせず例外とする（黙って壊れた
 * データを書かない）。
 */
export function createAutosaveSnapshot(
  scenario: AtcScenarioDefinition,
  session: AtcSessionState,
): AtcSessionFile {
  const checked = parseAtcSessionFile(serializeAtcSession(scenario, session));
  if (!checked.ok) {
    throw new Error(`atc-autosave-invalid-session: ${checked.errors.join(', ')}`);
  }
  return checked.file;
}

/**
 * 判定とスナップショット生成をまとめた純粋ヘルパー。
 * 保存すべきときは検証済みファイルと、次回判定に使う保存済み時計を返す。
 * 保存不要なときは null を返す（呼び出し側の状態は変わらない）。
 */
export function maybeAutosave(
  scenario: AtcScenarioDefinition,
  session: AtcSessionState,
  lastSavedClockSec: number | null,
  intervalSec: number = ATC_AUTOSAVE_INTERVAL_SEC,
): { file: AtcSessionFile; savedClockSec: number } | null {
  if (!shouldAutosave(session, lastSavedClockSec, intervalSec)) return null;
  return { file: createAutosaveSnapshot(scenario, session), savedClockSec: session.clockSec };
}
