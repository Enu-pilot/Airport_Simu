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

/**
 * ID 順に並べた値の配列。
 * 性能改善 第8弾: 比較ごとに文字列の切り出し・数値の解析をしないよう、要素ごとに 1 回だけ比較キー（接頭辞・数値）を作ってから並べる。
 * 比較の規則は compareIds と完全に同じ（接頭辞 → 数値 → 文字列）。Array.prototype.sort は安定なので結果の並びも同一。
 */
export function sortedValues<T extends { id: string }>(rec: Record<string, T>): T[] {
  const values = Object.values(rec);
  if (values.length < 2) return values;
  const keyed = values.map((v) => {
    const id = v.id;
    const u = id.indexOf('_');
    return { v, id, p: id.slice(0, u), n: Number.parseInt(id.slice(u + 1), 10) };
  });
  keyed.sort((a, b) => {
    if (a.p !== b.p) return a.p < b.p ? -1 : 1;
    if (a.n !== b.n) return a.n - b.n;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  for (let i = 0; i < keyed.length; i++) values[i] = keyed[i]!.v;
  return values;
}

/**
 * sortedValues の結果を、レコードの中身（キーの集合と各値の参照）が変わらない間だけ使い回す版（性能改善 第8弾）。
 * 検証は「要素数が同じ・並べた各要素がレコードの同じキーに同じ参照で残っている」ことの O(n) 確認で、並べ替えより軽い。
 * 要素数が同じで全要素がレコードに残っていればキーの集合も同一なので、返す並びは sortedValues と常に一致する。
 * 返した配列は共有されるため、呼び出し側は変更しないこと（読み取り専用の走査に使う）。
 */
const sortedCache = new WeakMap<object, unknown[]>();
export function sortedValuesCached<T extends { id: string }>(rec: Record<string, T>): readonly T[] {
  const cached = sortedCache.get(rec) as T[] | undefined;
  if (cached) {
    let count = 0;
    for (const _ in rec) count++;
    if (count === cached.length && cached.every((v) => rec[v.id] === v)) return cached;
  }
  const fresh = sortedValues(rec);
  sortedCache.set(rec, fresh);
  return fresh;
}
