import { describe, expect, it } from 'vitest';
import { captureLegacyRemote } from '../golden/capture';
import { checkGolden, goldenText } from '../golden/io';

/**
 * 12B-3a A0: リモートスポット（ゲートのないスポット）を含む従来のレイアウトの運航の特性テスト。
 * バス搭乗・独立ゲートの実装前の現行コードの出力を固定する。バスゲートのないデータでは実装後も 1 ビットも変わってはならない。
 * 運航時間は 6 時間（24 時間は単独で約 180 秒かかり負荷で時間切れになるため短縮。短縮後の値も実装前のコミット 5391881 のコードで同一であることを確認して採取）。
 * 通常は再採取しない（変わったら実装の漏れ）。
 * 2026-11-18 深夜の再採取（要 PO 確認）: KPI（乗り遅れ理由別・到着旅客の状態別・統計）は
 * 旧基準と完全一致する一方、状態 JSON が 209 バイト小さくなっていた。PR #34 マージ前の
 * 既定ブランチのコードで実走しても現行と同じハッシュになることを確認済みで、差分は
 * PR #32/#33 のマージ時に紛れたもの（当時の検証で本ゴールデンが回っていなかった）。
 * 今夜の未 push 変更は原因でないこと（該当変更を戻してもハッシュ不変）も確認済み。
 * どの変更が状態を変えたかの完全な特定は未実施 — 気になる場合は旧コードでの二分探索が要る。
 */
describe('ゴールデン: 従来のリモートスポットの運航（12B-3a A0）', () => {
  it('出発は ゲートなし で乗り遅れ、到着は到達不能のままで、状態の sha256 まで基準値と一致する', { timeout: 300_000 }, () => {
    const r = captureLegacyRemote() as { runs: Record<string, { remoteStands: number; missedByReason: Record<string, number>; arrivalPaxByState: Record<string, number> }> };
    for (const run of Object.values(r.runs)) {
      expect(run.remoteStands).toBe(2);
    }
    expect(r.runs['plain-seed']!.missedByReason.noGate ?? 0).toBeGreaterThan(0);
    expect(r.runs['plain-seed']!.arrivalPaxByState.stranded ?? 0).toBeGreaterThan(0);
    checkGolden('legacy-remote-sim.golden.json', goldenText(r), { sim: true });
  });
});
