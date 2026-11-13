import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useOps } from '../OpsPanels';
import type { OpsState } from '../../editor/store';
import { opsUi, type OverlayKey } from './opsUi';

/**
 * 運航モードの左右の列に常設するカード。見出しのボタンで詳細オーバーレイを開き、
 * 右端の ▾ で折りたたむ（開閉は localStorage に表示設定として保存。シミュレーションとは無関係）。
 */
const KEY = (id: string) => `skyport.ui.card.${id}`;

function loadOpen(id: string): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY(id)) !== 'closed';
  } catch {
    return true;
  }
}

export function Card({
  id,
  title,
  open,
  badge,
  children,
}: {
  id: string;
  title: string;
  /** 見出しから開く詳細オーバーレイ */
  open?: OverlayKey;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(() => loadOpen(id));
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      globalThis.localStorage?.setItem(KEY(id), next ? 'open' : 'closed');
    } catch {
      // 保存できなくても表示には影響しない
    }
  };
  return (
    <section className="card" data-testid={`card-${id}`}>
      <header className="card-head">
        {open ? (
          <button className="card-title" onClick={() => opsUi.openOverlay(open)} title="詳細を開く" data-testid={`card-${id}-open`}>
            {title}
          </button>
        ) : (
          <span className="card-title plain">{title}</span>
        )}
        {badge && <span className="card-badge">{badge}</span>}
        <button className="card-fold" onClick={toggle} title={expanded ? '折りたたむ' : '開く'} aria-label={expanded ? '折りたたむ' : '開く'} data-testid={`card-${id}-fold`}>
          {expanded ? '▾' : '▸'}
        </button>
      </header>
      {expanded && <div className="card-body">{children}</div>}
    </section>
  );
}

/** 小さな行（ラベルと値）。`table.board` は運航表だけが使うので、カードは div で組む */
export function CardRow({ label, children, tone, testid }: { label: ReactNode; children: ReactNode; tone?: 'warn' | 'bad' | 'ok'; testid?: string }) {
  return (
    <div className={`card-row ${tone ?? ''}`} data-testid={testid}>
      <span className="card-label">{label}</span>
      <span className="card-value">{children}</span>
    </div>
  );
}

/**
 * 重い集計を実時間で 1 秒に 1 回だけ作り直す（運航の状態は約 10Hz で更新されるので間引く）。
 * 運航を作り直したとき（sim が変わったとき）は直ちに作り直す。
 */
export function useSecondly<T>(compute: (o: OpsState) => T): T | null {
  const o = useOps();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const sim = o?.sim;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick で 1 秒ごとに作り直す。o は毎回変わる参照
  return useMemo(() => (o ? compute(o) : null), [tick, sim]);
}
