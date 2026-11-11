/**
 * レイアウトの版移行（一か所に集約）。新しい版を足すときはここに段を追加する。
 * 入力オブジェクトを直接書き換える（従来の挙動と同じ）。
 */

/**
 * 現行の版は SCHEMA_VERSION（model/types.ts）。
 * 構造的な移行は v1 → v2 のみ。v2 → v3 は任意項目の追加だけなので書き換えない（layout.schemaVersion も触らない）。
 */
export function migrateLayout(raw: unknown, fromVersion: number): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  const l = raw as Record<string, unknown>;
  // v1 → v2: ターミナル内部のエリアを追加
  if (fromVersion < 2) {
    l.terminalAreas = {};
    l.schemaVersion = 2;
  }
  // v2 → v3: 任意項目の追加のみ（自由形の滑走路・磁気偏差・ルール切替など）。書き換えなし

}
