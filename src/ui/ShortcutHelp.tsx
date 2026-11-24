import { useSyncExternalStore } from 'react';
import { useEditor } from '../editor/store';
import {
  BUILD_OVERLAY_TOGGLES,
  LEVEL_FOR_DIGIT_KEY,
  OPERATE_OVERLAY_TOGGLES,
  OPERATE_SPEED_KEYS,
  QUICK_BAR_SIZE,
  TOOL_FOR_KEY,
  type ShortcutRow,
} from '../editor/shortcuts';
import { floorDisplay } from '../core/model/levels';
import { toolLabel } from './Toolbox';

/**
 * ショートカット一覧（UX-1。`?` キーまたはトップバーのボタンで開閉）。
 * 表の中身は src/editor/shortcuts.ts の対応表（キー処理と同じ正本）から作り、仕様と表示がずれないようにする。
 */
let open = false;
const listeners = new Set<() => void>();
export const shortcutHelp = {
  isOpen: (): boolean => open,
  set(v: boolean): void {
    if (open === v) return;
    open = v;
    for (const l of listeners) l();
  },
  toggle(): void {
    shortcutHelp.set(!open);
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
export function useShortcutHelpOpen(): boolean {
  return useSyncExternalStore(shortcutHelp.subscribe, shortcutHelp.isOpen, shortcutHelp.isOpen);
}

const upper = (k: string): string => (k.length === 1 ? k.toUpperCase() : k);

/** 建設モードの一覧（表示順: ツール → サイズ・階 → 表示 → 編集操作 → 呼び出し） */
export function buildShortcutRows(): { title: string; rows: ShortcutRow[] }[] {
  const tools: ShortcutRow[] = [{ keys: 'V', label: '選択・移動' }, ...Object.entries(TOOL_FOR_KEY).map(([k, t]) => ({ keys: upper(k), label: toolLabel(t) }))];
  const digits = Object.entries(LEVEL_FOR_DIGIT_KEY)
    .sort((a, b) => a[1] - b[1])
    .map(([k, level]) => `${k}=${floorDisplay(level).building}`)
    .join(' ');
  return [
    { title: 'ツール', rows: tools },
    {
      title: 'サイズ・階',
      rows: [
        { keys: 'S / M / L / F', label: 'サイズ（誘導路の幅・スポット・滑走路の幅）。選択中の誘導路は経路全体の幅' },
        { keys: '8 9 0 1 2 3 4', label: `表示階（${digits}）` },
        { keys: 'A', label: '全レイヤ表示（配置先の階は維持）' },
      ],
    },
    { title: '表示', rows: BUILD_OVERLAY_TOGGLES.map((t) => ({ keys: upper(t.key), label: t.label })) },
    {
      title: '編集',
      rows: [
        { keys: 'R', label: '回転' },
        { keys: 'Enter / ダブルクリック', label: '誘導路・道路の確定' },
        { keys: 'Delete', label: '削除' },
        { keys: 'Ctrl+Z / Ctrl+Y', label: '元に戻す / やり直し' },
        { keys: 'Ctrl+D', label: '複製' },
        { keys: '矢印（Shift で 10）', label: '選択中を移動（未選択なら地図を移動）' },
        { keys: 'Space+ドラッグ', label: '地図を移動' },
        { keys: 'Esc', label: '描画中の取消 → ツール解除 → 選択解除' },
      ],
    },
    {
      title: '呼び出し',
      rows: [
        { keys: `Shift+1〜${QUICK_BAR_SIZE}`, label: 'クイックバー（最近使ったツール・ピン留め）' },
        { keys: '/', label: 'ツール検索' },
        { keys: '?', label: 'この一覧の開閉' },
      ],
    },
  ];
}

/** 運航モードの一覧 */
export function operateShortcutRows(): { title: string; rows: ShortcutRow[] }[] {
  return [
    { title: '時間', rows: [{ keys: 'Space', label: '一時停止 / 再開' }, ...OPERATE_SPEED_KEYS.map((r) => ({ keys: r.keys, label: `時間倍率 ${r.label}` }))] },
    { title: '表示', rows: OPERATE_OVERLAY_TOGGLES.map((t) => ({ keys: upper(t.key), label: t.label })) },
    {
      title: '操作',
      rows: [
        { keys: 'Esc', label: '選択解除・大きなパネルを閉じる' },
        { keys: '矢印（Shift で 10）', label: '地図を移動' },
        { keys: '?', label: 'この一覧の開閉' },
      ],
    },
  ];
}

export function ShortcutHelp() {
  const isOpen = useShortcutHelpOpen();
  const mode = useEditor((s) => s.mode);
  if (!isOpen) return null;
  const groups = mode === 'operate' ? operateShortcutRows() : buildShortcutRows();
  return (
    <div className="shortcut-help-backdrop" data-testid="shortcut-help" role="dialog" aria-label="ショートカット一覧" onClick={() => shortcutHelp.set(false)}>
      <div className="shortcut-help" onClick={(e) => e.stopPropagation()}>
        <div className="shortcut-help-head">
          <strong>ショートカット一覧（{mode === 'operate' ? '運航' : '建設'}）</strong>
          <button className="small" onClick={() => shortcutHelp.set(false)} data-testid="shortcut-help-close">
            閉じる（? / Esc）
          </button>
        </div>
        <div className="shortcut-help-grid">
          {groups.map((g) => (
            <section key={g.title}>
              <h4>{g.title}</h4>
              <table>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.keys + r.label}>
                      <td>
                        <kbd>{r.keys}</kbd>
                      </td>
                      <td>{r.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <div className="muted small">入力欄にカーソルがあるときは無効です。仕様は docs/06 §4.1.1。</div>
      </div>
    </div>
  );
}
