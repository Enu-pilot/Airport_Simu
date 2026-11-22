/**
 * レイアウトの版移行（一か所に集約）。新しい版を足すときはここに段を追加する。
 * 入力オブジェクトを直接書き換える（従来の挙動と同じ）。
 */

/**
 * 現行の版は SCHEMA_VERSION（model/types.ts）。
 * 構造的な移行は v1 → v2 のみ。v2 → v3 は任意項目の追加だけなので書き換えない（level 欠落は地上）。
 */
export function migrateLayout(raw: unknown, fromVersion: number): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  const l = raw as Record<string, unknown>;
  // v1 → v2: ターミナル内部のエリアを追加
  if (fromVersion < 2) {
    l.terminalAreas = {};
    l.schemaVersion = 2;
  }
  // v2 → v3: 任意項目のみ（自由形滑走路・磁気偏差・ルール切替・多層交通）。書き換えなし。

  normalizeTaxiwayWidthClasses(l);
}

/**
 * 2026-CF: 誘導路のコード F 表現の一本化（版に依らない正規化）。
 * 旧表現「widthClass 'L' ＋ codeF: true」を幅区分 'F' へ読み替え、誘導路の codeF は落とす。
 * (L, codeF) と 'F' はネットワーク導出・適合判定・描画幅のすべてで同値なので情報は失われない。
 * S/M に付いた codeF は従来も運航判定では無意味だった（L でのみ参照される）ため、読み替えずに落とす。
 * スポットの codeF は対象外（スポットは size ＋ codeF のまま）。
 */
function normalizeTaxiwayWidthClasses(l: Record<string, unknown>): void {
  const taxiways = l.taxiways;
  if (typeof taxiways !== 'object' || taxiways === null || Array.isArray(taxiways)) return;
  for (const e of Object.values(taxiways as Record<string, unknown>)) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue;
    const edge = e as Record<string, unknown>;
    if (edge.codeF === undefined) continue;
    if (edge.widthClass === 'L' && edge.codeF === true) edge.widthClass = 'F';
    delete edge.codeF;
  }
}
