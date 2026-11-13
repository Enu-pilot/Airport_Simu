import type { DayReview } from '../core/analytics/review';
import { retainHistoryDays } from '../core/io/historyPolicy';

/**
 * 日ごとの履歴の保存先（docs/21_save_format.md §7）。日次の締めごとに、その日の朝（締めの直後）の建設モードの復元点を残す。
 * 値はプロジェクトファイル（運航状態なし・シナリオなし）の JSON 文字列と、振り返りのデータ。
 * localStorage は容量が小さい（約 5MB）ので IndexedDB を使い、使えない環境ではメモリに置く（タブを閉じると消える）。
 * 書き込みのたびに保持規則（core/io/historyPolicy.ts）で整理する。
 */
export interface DayHistoryEntry {
  projectKey: string;
  /** 締めた後の会社の日（0 始まり。「n+1 日目の朝」に戻る） */
  day: number;
  savedAt: string;
  cash: number;
  rating: number;
  operatingProfit: number;
  review: DayReview;
  /** プロジェクトファイル（ProjectFile）の JSON。sim: null・scenarios: [] */
  projectJson: string;
}

export type DayHistorySummary = Omit<DayHistoryEntry, 'projectJson'> & { sizeKB: number };

export interface DayHistoryStore {
  readonly kind: 'indexeddb' | 'memory';
  /** 保存して、保持規則で整理する（currentDay = 今の日） */
  put(entry: DayHistoryEntry, currentDay: number): Promise<void>;
  /** 新しい日が先 */
  list(projectKey: string): Promise<DayHistorySummary[]>;
  get(projectKey: string, day: number): Promise<DayHistoryEntry | null>;
  remove(projectKey: string, day: number): Promise<void>;
  clear(projectKey: string): Promise<void>;
  /** 未保存のプロジェクトを保存したとき、履歴を新しい ID へ移す */
  rekey(from: string, to: string): Promise<void>;
}

const summarize = (e: DayHistoryEntry): DayHistorySummary => {
  const { projectJson, ...rest } = e;
  return { ...rest, sizeKB: Math.round(projectJson.length / 1024) };
};

export class MemoryHistoryStore implements DayHistoryStore {
  readonly kind = 'memory' as const;
  private map = new Map<string, DayHistoryEntry>();
  private k = (p: string, d: number) => `${p}:${d}`;

  put(entry: DayHistoryEntry, currentDay: number): Promise<void> {
    this.map.set(this.k(entry.projectKey, entry.day), entry);
    const days = [...this.map.values()].filter((e) => e.projectKey === entry.projectKey).map((e) => e.day);
    for (const d of retainHistoryDays(days, currentDay).drop) this.map.delete(this.k(entry.projectKey, d));
    return Promise.resolve();
  }
  list(projectKey: string): Promise<DayHistorySummary[]> {
    return Promise.resolve([...this.map.values()].filter((e) => e.projectKey === projectKey).sort((a, b) => b.day - a.day).map(summarize));
  }
  get(projectKey: string, day: number): Promise<DayHistoryEntry | null> {
    return Promise.resolve(this.map.get(this.k(projectKey, day)) ?? null);
  }
  remove(projectKey: string, day: number): Promise<void> {
    this.map.delete(this.k(projectKey, day));
    return Promise.resolve();
  }
  clear(projectKey: string): Promise<void> {
    for (const [k, e] of this.map) if (e.projectKey === projectKey) this.map.delete(k);
    return Promise.resolve();
  }
  async rekey(from: string, to: string): Promise<void> {
    for (const [k, e] of [...this.map]) {
      if (e.projectKey !== from) continue;
      this.map.delete(k);
      this.map.set(this.k(to, e.day), { ...e, projectKey: to });
    }
  }
}

const DB_NAME = 'skyport';
const STORE = 'dayHistory';

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB error'));
  });
const done = (t: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('IndexedDB error'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB aborted'));
  });

export class IndexedDbHistoryStore implements DayHistoryStore {
  readonly kind = 'indexeddb' as const;
  constructor(private db: IDBDatabase) {}

  static open(factory: IDBFactory): Promise<IndexedDbHistoryStore> {
    return new Promise((resolve, reject) => {
      const r = factory.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('projectKey', 'projectKey');
      };
      r.onsuccess = () => resolve(new IndexedDbHistoryStore(r.result));
      r.onerror = () => reject(r.error ?? new Error('IndexedDB open error'));
      r.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }

  private store(mode: IDBTransactionMode): { tx: IDBTransaction; s: IDBObjectStore } {
    const tx = this.db.transaction(STORE, mode);
    return { tx, s: tx.objectStore(STORE) };
  }
  private id = (p: string, d: number) => `${p}:${d}`;

  private async all(projectKey: string): Promise<(DayHistoryEntry & { id: string })[]> {
    const { s } = this.store('readonly');
    return req(s.index('projectKey').getAll(projectKey)) as Promise<(DayHistoryEntry & { id: string })[]>;
  }

  async put(entry: DayHistoryEntry, currentDay: number): Promise<void> {
    const { tx, s } = this.store('readwrite');
    s.put({ ...entry, id: this.id(entry.projectKey, entry.day) });
    await done(tx);
    const days = (await this.all(entry.projectKey)).map((e) => e.day);
    const drop = retainHistoryDays(days, currentDay).drop;
    if (drop.length === 0) return;
    const w = this.store('readwrite');
    for (const d of drop) w.s.delete(this.id(entry.projectKey, d));
    await done(w.tx);
  }
  async list(projectKey: string): Promise<DayHistorySummary[]> {
    return (await this.all(projectKey)).sort((a, b) => b.day - a.day).map(summarize);
  }
  async get(projectKey: string, day: number): Promise<DayHistoryEntry | null> {
    const { s } = this.store('readonly');
    return ((await req(s.get(this.id(projectKey, day)))) as DayHistoryEntry | undefined) ?? null;
  }
  async remove(projectKey: string, day: number): Promise<void> {
    const { tx, s } = this.store('readwrite');
    s.delete(this.id(projectKey, day));
    await done(tx);
  }
  async clear(projectKey: string): Promise<void> {
    const rows = await this.all(projectKey);
    const { tx, s } = this.store('readwrite');
    for (const r of rows) s.delete(r.id);
    await done(tx);
  }
  async rekey(from: string, to: string): Promise<void> {
    const rows = await this.all(from);
    const { tx, s } = this.store('readwrite');
    for (const r of rows) {
      s.delete(r.id);
      s.put({ ...r, projectKey: to, id: this.id(to, r.day) });
    }
    await done(tx);
  }
}

let current: Promise<DayHistoryStore> | null = null;
let fallbackNotified = false;

/** 保存先を返す（最初の 1 回で IndexedDB を開く。使えなければメモリ。notify はメモリに切り替えたとき 1 回だけ呼ぶ） */
export function getHistoryStore(notify?: () => void): Promise<DayHistoryStore> {
  current ??= (async (): Promise<DayHistoryStore> => {
    try {
      const f = globalThis.indexedDB;
      if (!f) throw new Error('no indexedDB');
      return await IndexedDbHistoryStore.open(f);
    } catch {
      return new MemoryHistoryStore();
    }
  })();
  return current.then((s) => {
    if (s.kind === 'memory' && !fallbackNotified && notify) {
      fallbackNotified = true;
      notify();
    }
    return s;
  });
}

/** テスト用: 保存先を差し替える・戻す */
export function setHistoryStoreForTest(s: DayHistoryStore | null): void {
  current = s ? Promise.resolve(s) : null;
  fallbackNotified = false;
}

export const UNSAVED_KEY = 'unsaved';

/** 未保存のプロジェクトの履歴を捨てる（新しいゲームを始めたとき） */
export async function clearUnsavedHistory(): Promise<void> {
  try {
    await (await getHistoryStore()).clear(UNSAVED_KEY);
  } catch {
    // 履歴が使えなくてもゲームは続けられる
  }
}
