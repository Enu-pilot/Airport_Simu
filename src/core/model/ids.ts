/** ID の接頭辞と数値部分で比較する（処理順を決定的にするため） */
export function compareIds(a: string, b: string): number {
  const pa = a.slice(0, a.indexOf('_'));
  const pb = b.slice(0, b.indexOf('_'));
  if (pa !== pb) return pa < pb ? -1 : 1;
  const na = Number.parseInt(a.slice(a.indexOf('_') + 1), 10);
  const nb = Number.parseInt(b.slice(b.indexOf('_') + 1), 10);
  if (na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ID 順に並べた値の配列 */
export function sortedValues<T extends { id: string }>(rec: Record<string, T>): T[] {
  return Object.values(rec).sort((a, b) => compareIds(a.id, b.id));
}
