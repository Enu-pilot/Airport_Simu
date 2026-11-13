import { editorStore } from './store';

/** 1 日のループの表示だけの操作（履歴のオーバーレイの開閉） */
export const dayFlowActions = {
  openHistory(open: boolean): void {
    const df = editorStore.getState().dayFlow;
    if (df.historyOpen !== open) editorStore.setState({ dayFlow: { ...df, historyOpen: open } });
  },
};
