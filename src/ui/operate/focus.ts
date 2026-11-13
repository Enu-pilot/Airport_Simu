import { worldToMap } from '../../core/geometry/frames';
import { actions, editorStore } from '../../editor/store';
import { entityCenter, focusEntity } from '../../editor/input';
import { ops } from '../../editor/simRunner';

/**
 * カメラを対象へ移して選択する。対象は施設・滑走路・スポットなどのレイアウトの ID。
 * 設備キー・車両の ID など、マップ上に位置を持たないものは何もしない。
 */
export function focusTarget(id: string | null): boolean {
  if (!id) return false;
  const layout = editorStore.getState().history.present;
  if (!entityCenter(layout, id)) return false;
  ops.selectAircraft(null);
  focusEntity(id);
  return true;
}

/** 機体を選択して、飛行前でなければカメラを機体へ移す（運航表・アラート・イベントからの移動） */
export function selectAircraftAndFocus(acId: string): void {
  ops.selectAircraft(acId);
  const ac = editorStore.getState().ops?.sim.state.aircraft[acId];
  if (ac && ac.state !== 'scheduled') actions.focus(worldToMap(ac));
}
