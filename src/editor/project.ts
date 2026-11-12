import { CATALOG_VERSION } from '../core/aircraft/catalog';
import {
  buildProject,
  effectiveModels,
  restoreSimulation,
  serializeProject,
  validateProject,
  type ProjectFile,
  type ValidationReport,
} from '../core/io/project';
import { createHistory } from '../core/editor/history';
import { editorStore, newGame, replaceLayout, showToast } from './store';
import { SAVE_FORMAT } from '../core/io/serialize';
import { ops } from './simRunner';

/**
 * プロジェクトの操作（docs/21_save_format.md）: 新規・保存・名前を付けて保存・読み込み・削除・JSON の書き出し / 読み込み。
 *
 * 保存先はブラウザの localStorage（スロットごとに 1 キー）。読み込みは必ず「検証 → 成功したときだけ適用」で、
 * 検証に失敗したときは開いているプロジェクトを一切変更しない。
 */

const get = editorStore.getState;
const set = editorStore.setState;

const INDEX_KEY = 'skyport.projects.v1';
const slotKey = (id: string) => `skyport.project.v1.${id}`;

export interface SlotInfo {
  id: string;
  name: string;
  savedAt: string;
  catalog: string;
  /** 運航中に保存した（運航状態を含む） */
  withSim: boolean;
  sizeKB: number;
}

export function listSlots(): SlotInfo[] {
  try {
    const raw = globalThis.localStorage?.getItem(INDEX_KEY);
    const list = raw ? (JSON.parse(raw) as SlotInfo[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeIndex(list: SlotInfo[]): void {
  globalThis.localStorage?.setItem(INDEX_KEY, JSON.stringify(list));
}

/** 開いている状態からプロジェクトファイルを作る（運航中なら運航状態も含める） */
export function currentProject(name = get().projectName): ProjectFile {
  const s = get();
  return buildProject({
    name,
    savedAt: new Date().toISOString(),
    layout: s.history.present,
    company: s.company,
    pin: s.catalogPin,
    scenarios: s.scenarios,
    sim: s.ops?.sim ?? null,
  });
}

let slotSeq = 0;
function newSlotId(): string {
  const used = new Set(listSlots().map((x) => x.id));
  let id = `p${Date.now().toString(36)}${++slotSeq}`;
  while (used.has(id)) id = `p${Date.now().toString(36)}${++slotSeq}`;
  return id;
}

function writeSlot(id: string, p: ProjectFile): boolean {
  const json = serializeProject(p);
  try {
    globalThis.localStorage?.setItem(slotKey(id), json);
    const info: SlotInfo = { id, name: p.name, savedAt: p.savedAt, catalog: p.catalog.version, withSim: p.sim !== null, sizeKB: Math.round(json.length / 1024) };
    writeIndex([info, ...listSlots().filter((x) => x.id !== id)]);
    return true;
  } catch (e) {
    showToast(`保存できませんでした（ブラウザの保存容量が足りない可能性があります）: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return false;
  }
}

/**
 * 検証済みのプロジェクトを開く。運航中なら運航を終えてから置き換える。
 * 運航状態を含むプロジェクトは、一時停止した運航モードで再開する。
 */
function applyProject(p: ProjectFile, id: string | null): void {
  if (get().mode === 'operate') ops.stop();
  const pin = { version: p.catalog.version, models: p.catalog.models };
  set({
    history: createHistory(p.layout),
    company: p.company,
    charges: { past: [], future: [] },
    scenarios: p.scenarios,
    scenarioRun: null,
    selection: null,
    draft: null,
    tool: 'select',
    projectId: id,
    projectName: p.name,
    catalogPin: pin,
  });
  if (p.sim) {
    const { sim, violations, repaired } = restoreSimulation(p.layout, p.sim, effectiveModels(pin));
    // 検証で復元済みなので通常は起きない。万一不整合なら運航状態は使わない
    if (violations.length) showToast(`運航状態に不整合があったため建設モードで開きました: ${violations[0]}`, 'error');
    else {
      if (repaired.length > 0) showToast(`横断の占有の不整合を修復して運航状態を開きました（${repaired.length} 件）`);
      ops.resume(sim);
    }
  }
}

export const projectActions = {
  /** 上書き保存（未保存なら新しいスロットを作る） */
  save(): void {
    const s = get();
    const id = s.projectId ?? newSlotId();
    if (writeSlot(id, currentProject())) {
      set({ projectId: id });
      showToast(`「${s.projectName}」を保存しました${s.ops ? '（運航状態を含む）' : ''}`);
    }
  },
  saveAs(name: string): void {
    const n = name.trim() || '無題のプロジェクト';
    const id = newSlotId();
    if (writeSlot(id, currentProject(n))) {
      set({ projectId: id, projectName: n });
      showToast(`「${n}」として保存しました`);
    }
  },
  rename(name: string): void {
    set({ projectName: name.trim() || '無題のプロジェクト' });
  },
  /** スロットから開く。検証で失敗したら何も変更せず、報告を返す */
  load(id: string): ValidationReport {
    let json: string | null;
    try {
      json = globalThis.localStorage?.getItem(slotKey(id)) ?? null;
    } catch {
      json = null;
    }
    if (json === null) return { ok: false, errors: ['保存データが見つかりません'], warnings: [], migratedFrom: null, project: null };
    const r = validateProject(json, { fallbackCompany: get().company });
    if (r.ok && r.project) {
      applyProject(r.project, id);
      showToast(`「${r.project.name}」を開きました${r.warnings.length ? `（注意 ${r.warnings.length} 件）` : ''}`);
    } else showToast(`開けませんでした: ${r.errors[0]}（開いているプロジェクトは変更していません）`, 'error');
    return r;
  },
  remove(id: string): void {
    try {
      globalThis.localStorage?.removeItem(slotKey(id));
      writeIndex(listSlots().filter((x) => x.id !== id));
    } catch {
      // 削除できなくても続けられる
    }
    if (get().projectId === id) set({ projectId: null });
  },
  /** JSON ファイルとして書き出す内容 */
  exportJson(): { fileName: string; json: string } {
    const p = currentProject();
    // ファイル名は ASCII に限る（日本語のファイル名は環境によって「download」に置き換わるため）。名前はファイルの中に保存される
    const ascii = p.name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    return { fileName: `skyport-${ascii || 'project'}-${stamp}.skyport.json`, json: serializeProject(p) };
  },
  /** JSON を読み込む（旧形式のレイアウトファイルも移行して読む）。検証で失敗したら何も変更しない */
  importJson(json: string, fileName: string): ValidationReport {
    const r = validateProject(json, { fallbackCompany: get().company, name: fileName.replace(/\.json$/i, ''), savedAt: new Date().toISOString() });
    if (r.ok && r.project && r.migratedFrom === SAVE_FORMAT) {
      // 旧形式のレイアウトだけのファイル: これまでどおりレイアウトの置き換えとして扱う（建設費の精算・元に戻すが効く）
      if (get().mode === 'operate') {
        showToast('運航中はレイアウトを読み込めません。建設モードで行ってください', 'error');
        return { ...r, ok: false, errors: ['運航中はレイアウトを読み込めません'], project: null };
      }
      replaceLayout(r.project.layout, `${fileName} を読み込みました（旧形式のレイアウトファイル）`);
    } else if (r.ok && r.project) {
      applyProject(r.project, null);
      showToast(`${fileName} を読み込みました${r.migratedFrom ? '（旧形式から移行）' : ''}${r.warnings.length ? `（注意 ${r.warnings.length} 件）` : ''}`);
    } else showToast(`${fileName} は読み込めません: ${r.errors[0]}（開いているプロジェクトは変更していません）`, 'error');
    return r;
  },
  /** 差分を確認したうえで、最新カタログの機種データに切り替える */
  applyLatestCatalog(): void {
    if (get().mode === 'operate') {
      showToast('運航中は機種データを切り替えられません。建設モードで行ってください', 'error');
      return;
    }
    set({ catalogPin: null });
    showToast(`最新の機種カタログ（${CATALOG_VERSION}）を使うようにしました。次に保存するとこの版で固定されます`);
  },
  newProject(mode: 'career' | 'sandbox'): void {
    newGame(mode);
  },
};
