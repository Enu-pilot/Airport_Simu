import { useState, type ReactNode } from 'react';

/** プロパティ欄の共通部品（PropertiesPanel・RunwayPanels で共有） */

export function Section({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <div className="prop-section" data-testid={testid}>
      <div className="prop-section-title">{title}</div>
      {children}
    </div>
  );
}

export function Field({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <label className="prop-field" title={title}>
      <span className="prop-label">{label}</span>
      <span className="prop-value">{children}</span>
    </label>
  );
}

export function Info({ label, children, testid, title }: { label: string; children: ReactNode; testid?: string; title?: string }) {
  return (
    <div className="prop-field" title={title}>
      <span className="prop-label">{label}</span>
      <span className="prop-value info" data-testid={testid}>
        {children}
      </span>
    </div>
  );
}

/** Enter またはフォーカスアウトで確定するテキスト入力（1回の確定 = 1回の履歴） */
export function TextInput({ value, onCommit, testid }: { value: string; onCommit: (v: string) => void; testid?: string }) {
  const [draft, setDraft] = useState(value);
  // 外部（Undo など）で値が変わったら入力中の値を置き換える
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      type="text"
      value={draft}
      maxLength={40}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      data-testid={testid}
    />
  );
}

/** 整数の入力。範囲外・整数でない値は元に戻す */
export function NumberInput({ value, min, max, onCommit, testid }: { value: number; min: number; max: number; onCommit: (v: number) => void; testid?: string }) {
  const [draft, setDraft] = useState(String(value));
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setDraft(String(value));
  }
  const commit = () => {
    const v = Number(draft);
    if (!Number.isInteger(v) || v < min || v > max) {
      setDraft(String(value));
      return;
    }
    if (v !== value) onCommit(v);
  };
  return (
    <input
      type="number"
      value={draft}
      min={min}
      max={max}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      data-testid={testid}
    />
  );
}

/**
 * 実数の入力（Enter・フォーカスアウトで確定）。範囲外・数値でない値は元に戻す。
 * 表示は有効数字を落とさない（保存値をそのまま文字列にする）。
 */
export function DecimalInput({
  value,
  min,
  max,
  step,
  onCommit,
  testid,
  placeholder,
}: {
  value: number | undefined;
  min: number;
  max: number;
  step?: number;
  onCommit: (v: number) => void;
  testid?: string;
  placeholder?: string;
}) {
  const text = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(text);
  const [prev, setPrev] = useState(text);
  if (prev !== text) {
    setPrev(text);
    setDraft(text);
  }
  const commit = () => {
    if (draft.trim() === '') {
      setDraft(text);
      return;
    }
    const v = Number(draft);
    if (!Number.isFinite(v) || v < min || v > max) {
      setDraft(text);
      return;
    }
    if (v !== value) onCommit(v);
  };
  return (
    <input
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step ?? 'any'}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      data-testid={testid}
    />
  );
}
