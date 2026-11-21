import { describe, expect, it } from 'vitest';
import { HEADLESS_PUBLISH_MS, headlessShouldPublish } from '../../src/editor/simRunner';

/**
 * 無描画運行モード（性能改善計画 第5弾）の store 公開判定。
 * 間隔（約1秒）までは公開せず、日次締めでの停止と dropped の立ち上がりでは即時に公開する。
 * 公開を間引いても tick の列は変わらない（端数 clock の保持は simRunner 側）ことの前提条件だけをここで固定する。
 */
describe('無描画運行モードの公開判定', () => {
  it('公開間隔は約1秒', () => {
    expect(HEADLESS_PUBLISH_MS).toBe(1000);
  });

  it('間隔未満では公開しない', () => {
    expect(headlessShouldPublish({ elapsedMs: 0, stoppedAtClose: false, droppedRose: false })).toBe(false);
    expect(headlessShouldPublish({ elapsedMs: HEADLESS_PUBLISH_MS - 1, stoppedAtClose: false, droppedRose: false })).toBe(false);
  });

  it('間隔に達したら公開する', () => {
    expect(headlessShouldPublish({ elapsedMs: HEADLESS_PUBLISH_MS, stoppedAtClose: false, droppedRose: false })).toBe(true);
    expect(headlessShouldPublish({ elapsedMs: HEADLESS_PUBLISH_MS * 5, stoppedAtClose: false, droppedRose: false })).toBe(true);
  });

  it('日次締めで止まったときは間隔を待たずに公開する（振り返りへ即時に切り替える）', () => {
    expect(headlessShouldPublish({ elapsedMs: 0, stoppedAtClose: true, droppedRose: false })).toBe(true);
  });

  it('dropped が新たに立ったときは間隔を待たずに公開する（警告を早く出す）', () => {
    expect(headlessShouldPublish({ elapsedMs: 0, stoppedAtClose: false, droppedRose: true })).toBe(true);
  });
});
