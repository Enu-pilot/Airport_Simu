import { buildProject, serializeProject } from '../core/io/project';
import { applyCompletedProjects } from '../core/economy/expansion';
import type { DayReview } from '../core/analytics/review';
import type { Simulation } from '../core/sim/simulation';
import { editorStore, showToast } from './store';
import { getHistoryStore, UNSAVED_KEY, type DayHistoryEntry } from './dayHistoryStore';
import { effectiveModels } from '../core/io/project';
import { updateJournal } from '../core/analytics/journal';
import { DAY_SEC } from '../core/sim/rules';

/**
 * 日次の締めの履歴を残す（保存先は dayHistoryStore.ts、保持規則は core/io/historyPolicy.ts）。
 * 復元点は「その日の朝」の建設モードの状態（運航状態なし・シナリオなし）。完了した工事は、運航を終えたときと同じようにレイアウトへ反映する。
 */
export const historyKey = (): string => editorStore.getState().projectId ?? UNSAVED_KEY;

export function recordDayClose(sim: Simulation, review: DayReview): void {
  const s = editorStore.getState();
  const c = sim.company;
  if (!c) return;
  const from = sim.state.economy?.periodStart ?? Math.max(0, sim.state.now - DAY_SEC);
  const journal = updateJournal(s.journal, sim.state.analytics.records, from, sim.state.now, review.day, effectiveModels(s.catalogPin));
  editorStore.setState({ journal });
  const company = structuredClone(c);
  const layout = applyCompletedProjects(company, s.history.present) ?? s.history.present;
  const project = buildProject({ name: s.projectName, savedAt: new Date().toISOString(), layout, company, pin: s.catalogPin, scenarios: [], sim: null, journal });
  const entry: DayHistoryEntry = {
    projectKey: historyKey(),
    day: company.day,
    savedAt: project.savedAt,
    cash: company.cash,
    rating: company.rating,
    operatingProfit: review.report.operatingProfit,
    review,
    projectJson: serializeProject(project),
  };
  void getHistoryStore(() => showToast('履歴はこのタブを閉じると消えます（このブラウザでは IndexedDB を使えません）'))
    .then((st) => st.put(entry, company.day))
    .then(() => historyListeners.forEach((l) => l()))
    .catch(() => showToast('日ごとの履歴を保存できませんでした', 'error'));
}

const historyListeners = new Set<() => void>();
/** 履歴が変わったとき（一覧の再読み込み用） */
export function onHistoryChanged(l: () => void): () => void {
  historyListeners.add(l);
  return () => historyListeners.delete(l);
}
export function notifyHistoryChanged(): void {
  historyListeners.forEach((l) => l());
}
