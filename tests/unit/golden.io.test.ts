import { describe, expect, it } from 'vitest';
import { isVersionOnlyChange } from '../golden/io';

const base = { simModelVersion: 'skyport-sim-10.0', now: 28800, length: 219654, sha256: 'aaa', normalizedSha256: 'nnn' };
const t = (o: unknown) => JSON.stringify(o, null, 1) + '\n';

describe('運航ゴールデンの再採取の例外（版に敏感なキーだけの変更）', () => {
  it('sha256・length だけが変わり normalizedSha256 が同じなら許可する', () => {
    expect(isVersionOnlyChange(t(base), t({ ...base, sha256: 'bbb', length: 219654 }))).toBe(true);
    expect(isVersionOnlyChange(t(base), t({ ...base, sha256: 'bbb', length: 219655 }))).toBe(true);
  });
  it('変更なしも許可（呼び出し側が差分の有無を別に見る）', () => {
    expect(isVersionOnlyChange(t(base), t(base))).toBe(true);
  });
  it('normalizedSha256 が違えば拒否する（運航結果・データの変化）', () => {
    expect(isVersionOnlyChange(t(base), t({ ...base, sha256: 'bbb', normalizedSha256: 'mmm' }))).toBe(false);
  });
  it('版に敏感でないキー（now など）が違えば拒否する', () => {
    expect(isVersionOnlyChange(t(base), t({ ...base, sha256: 'bbb', now: 28801 }))).toBe(false);
    expect(isVersionOnlyChange(t(base), t({ ...base, simModelVersion: 'x' }))).toBe(false);
  });
  it('normalizedSha256 が無い・構造が違う・JSON でないものは拒否する', () => {
    const { normalizedSha256: _n, ...noNorm } = base;
    void _n;
    expect(isVersionOnlyChange(t(noNorm), t({ ...noNorm, sha256: 'b' }))).toBe(false);
    expect(isVersionOnlyChange(t(base), t({ ...base, extra: 1 }))).toBe(false);
    expect(isVersionOnlyChange('not json', t(base))).toBe(false);
    expect(isVersionOnlyChange(t({ ...base, list: [1, 2] }), t({ ...base, list: [1] }))).toBe(false);
  });
});
