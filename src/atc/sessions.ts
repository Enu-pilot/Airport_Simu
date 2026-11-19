import {
  parseAtcSessionFile,
  serializeAtcSession,
  type AtcSessionFile,
} from '../core/atc/persistence';
import type { AtcScenarioDefinition, AtcSessionState } from '../core/atc/types';

/**
 * ATC-10: ATC専用セッションストア（アプリ側）。
 *
 * 保存先は経営モードと完全に分離する:
 * - IndexedDB データベース名は専用の `skyport-atc`（経営側の `skyport`
 *   DB・dayHistory ストア・プロジェクト保存キー/一覧とは無関係）。
 * - 値はいずれも ATC専用セーブ形式（skyport-atc-session）の JSON 文字列で、
 *   書き込み前・読み込み時の双方で core/atc/persistence の検証を通す。
 *   検証に失敗したデータは書かず、読み込みでも現在の状態へ一切触れずに
 *   エラーとして返す（純粋な読み取りのみ）。
 * - IndexedDB が使えない環境ではメモリ実装へフォールバックする
 *   （タブを閉じると消える。経営側 dayHistoryStore と同方針だが、
 *   コードは共有せず ATC 側で独立に持つ）。
 *
 * ストレージ本体（AtcSessionBackend）は差し替え可能で、単体テストは
 * メモリ実装で検証する。fake-indexeddb 等の新規依存は追加しない。
 */

export type AtcSessionSaveKind = 'manual' | 'autosave';

/** セッション一覧に出すメタ情報（セーブ本体の JSON は含まない） */
export interface AtcSessionSummary {
  id: string;
  kind: AtcSessionSaveKind;
  scenarioId: string;
  /** シナリオ名（表示用） */
  scenarioName: string;
  /** 保存時刻（ISO文字列） */
  savedAtIso: string;
  /** 保存時点のセッション経過秒 */
  clockSec: number;
  /** 保存時点で終了していたか */
  finished: boolean;
}

/** ストアに保存されるレコード（一覧用メタ＋検証済み JSON 本体） */
export interface AtcSessionRecord extends AtcSessionSummary {
  json: string;
}

export type SaveAtcSessionResult =
  | { ok: true; summary: AtcSessionSummary }
  | { ok: false; errors: string[] };

export type LoadAtcSessionResult =
  | { ok: true; file: AtcSessionFile; summary: AtcSessionSummary }
  | { ok: false; errors: string[] };

/** 自動保存スロットの決定的 ID（シナリオごとに1枠、上書き保存する） */
export function autosaveSlotId(scenarioId: string): string {
  return `autosave:${scenarioId}`;
}

const summarizeRecord = (r: AtcSessionRecord): AtcSessionSummary => {
  const { json: _json, ...summary } = r;
  return summary;
};

/**
 * ストレージ本体の差し替え口。レコード単位の素朴な読み書きだけを持ち、
 * 検証・シリアライズの責務は AtcSessionStore 側に置く（どの実装でも
 * 同じ検証を通ることを保証するため）。
 */
export interface AtcSessionBackend {
  readonly kind: 'indexeddb' | 'memory';
  get(id: string): Promise<AtcSessionRecord | null>;
  put(record: AtcSessionRecord): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<AtcSessionRecord[]>;
}

export class MemoryAtcSessionBackend implements AtcSessionBackend {
  readonly kind = 'memory' as const;
  /** テストから破損データの混入を再現できるよう公開する（通常は触らない） */
  readonly records = new Map<string, AtcSessionRecord>();

  get(id: string): Promise<AtcSessionRecord | null> {
    return Promise.resolve(this.records.get(id) ?? null);
  }
  put(record: AtcSessionRecord): Promise<void> {
    this.records.set(record.id, record);
    return Promise.resolve();
  }
  delete(id: string): Promise<void> {
    this.records.delete(id);
    return Promise.resolve();
  }
  list(): Promise<AtcSessionRecord[]> {
    return Promise.resolve([...this.records.values()]);
  }
}

const DB_NAME = 'skyport-atc';
const STORE = 'sessions';

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

export class IndexedDbAtcSessionBackend implements AtcSessionBackend {
  readonly kind = 'indexeddb' as const;
  constructor(private db: IDBDatabase) {}

  static open(factory: IDBFactory): Promise<IndexedDbAtcSessionBackend> {
    return new Promise((resolve, reject) => {
      const r = factory.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(new IndexedDbAtcSessionBackend(r.result));
      r.onerror = () => reject(r.error ?? new Error('IndexedDB open error'));
      r.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }

  private store(mode: IDBTransactionMode): { tx: IDBTransaction; s: IDBObjectStore } {
    const tx = this.db.transaction(STORE, mode);
    return { tx, s: tx.objectStore(STORE) };
  }

  async get(id: string): Promise<AtcSessionRecord | null> {
    const { s } = this.store('readonly');
    return ((await req(s.get(id))) as AtcSessionRecord | undefined) ?? null;
  }
  async put(record: AtcSessionRecord): Promise<void> {
    const { tx, s } = this.store('readwrite');
    s.put(record);
    await done(tx);
  }
  async delete(id: string): Promise<void> {
    const { tx, s } = this.store('readwrite');
    s.delete(id);
    await done(tx);
  }
  async list(): Promise<AtcSessionRecord[]> {
    const { s } = this.store('readonly');
    return req(s.getAll()) as Promise<AtcSessionRecord[]>;
  }
}

/**
 * ATCセッションの保存・読み込み・一覧・削除。
 * 保存は「シリアライズ→検証→書き込み」の順で、検証を通らない状態は
 * 一切書き込まない。読み込みは保存済み JSON を必ず検証し直し、
 * 不正・未知版・破損データでは現在の状態を変更せずエラーだけを返す。
 */
export class AtcSessionStore {
  constructor(private backend: AtcSessionBackend) {}

  get kind(): 'indexeddb' | 'memory' {
    return this.backend.kind;
  }

  async save(input: {
    scenario: AtcScenarioDefinition;
    session: AtcSessionState;
    /** 省略時は kind・シナリオ・保存時刻から決める。自動保存は autosaveSlotId を使うこと */
    id?: string;
    kind?: AtcSessionSaveKind;
    /** 省略時は現在時刻 */
    savedAtIso?: string;
  }): Promise<SaveAtcSessionResult> {
    const checked = parseAtcSessionFile(serializeAtcSession(input.scenario, input.session));
    if (!checked.ok) return { ok: false, errors: checked.errors };
    return this.writeFile(checked.file, {
      id: input.id,
      kind: input.kind ?? 'manual',
      savedAtIso: input.savedAtIso,
    });
  }

  /** JSON 文字列（ファイル/クリップボード等）からの取り込み。検証を通らない入力は保存しない */
  async importJson(
    json: string,
    opts: { id?: string; kind?: AtcSessionSaveKind; savedAtIso?: string } = {},
  ): Promise<SaveAtcSessionResult> {
    const checked = parseAtcSessionFile(json);
    if (!checked.ok) return { ok: false, errors: checked.errors };
    return this.writeFile(checked.file, {
      id: opts.id,
      kind: opts.kind ?? 'manual',
      savedAtIso: opts.savedAtIso,
    });
  }

  private async writeFile(
    file: AtcSessionFile,
    opts: { id?: string; kind: AtcSessionSaveKind; savedAtIso?: string },
  ): Promise<SaveAtcSessionResult> {
    const savedAtIso = opts.savedAtIso ?? new Date().toISOString();
    const record: AtcSessionRecord = {
      id: opts.id ?? `${opts.kind}:${file.scenario.id}:${savedAtIso}`,
      kind: opts.kind,
      scenarioId: file.scenario.id,
      scenarioName: file.scenario.name,
      savedAtIso,
      clockSec: file.session.clockSec,
      finished: file.session.finished,
      json: JSON.stringify(file),
    };
    await this.backend.put(record);
    return { ok: true, summary: summarizeRecord(record) };
  }

  /** 新しい保存が先 */
  async list(): Promise<AtcSessionSummary[]> {
    const records = await this.backend.list();
    return records
      .sort((a, b) => (a.savedAtIso < b.savedAtIso ? 1 : a.savedAtIso > b.savedAtIso ? -1 : 0))
      .map(summarizeRecord);
  }

  async load(id: string): Promise<LoadAtcSessionResult> {
    const record = await this.backend.get(id);
    if (!record) return { ok: false, errors: ['not-found'] };
    const checked = parseAtcSessionFile(record.json);
    if (!checked.ok) return { ok: false, errors: checked.errors };
    return { ok: true, file: checked.file, summary: summarizeRecord(record) };
  }

  async remove(id: string): Promise<void> {
    await this.backend.delete(id);
  }
}

/** テスト・UI の単体検証用: メモリ実装のストアを作る */
export function createMemoryAtcSessionStore(): AtcSessionStore {
  return new AtcSessionStore(new MemoryAtcSessionBackend());
}

let current: Promise<AtcSessionStore> | null = null;
let fallbackNotified = false;

/** 保存先を返す（最初の1回で IndexedDB を開く。使えなければメモリ。notify はメモリに切り替えたとき1回だけ呼ぶ） */
export function getAtcSessionStore(notify?: () => void): Promise<AtcSessionStore> {
  current ??= (async (): Promise<AtcSessionStore> => {
    try {
      const f = globalThis.indexedDB;
      if (!f) throw new Error('no indexedDB');
      return new AtcSessionStore(await IndexedDbAtcSessionBackend.open(f));
    } catch {
      return createMemoryAtcSessionStore();
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
export function setAtcSessionStoreForTest(s: AtcSessionStore | null): void {
  current = s ? Promise.resolve(s) : null;
  fallbackNotified = false;
}
