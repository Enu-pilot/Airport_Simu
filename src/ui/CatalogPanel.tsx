import { useMemo, useState } from 'react';
import { AIRCRAFT_MODELS, CATALOG, CATALOG_VERSION, DATA_SOURCES, MANUFACTURERS, codeLetterOf, type AircraftModel, type Sourced } from '../core/aircraft/catalog';
import { checkAirport, requiredRunwayM } from '../core/aircraft/compat';
import { AIRCRAFT_TYPES } from '../core/sim/aircraftTypes';
import { buildAirsideNetwork } from '../core/airside/network';
import { maxSeatsOf } from '../core/economy/company';
import { AIRLINES } from '../core/economy/registry';
import { companyActions } from '../editor/simRunner';
import { useLayout } from '../editor/store';
import { useCompany } from './ManagementPanels';
import { COMPAT_REASON_LABEL, COMPAT_STATUS_LABEL, DATA_STATUS_LABEL, displayName } from '../i18n/ja';
import type { SizeClass } from '../core/model/types';
import { ASSET_VERSION, assetOf, LIVERIES, supportList } from '../core/assets/registry';

const SUPPORT_LABEL = { dedicated: '専用モデル', template: '系統テンプレート＋機種寸法', fallback: '汎用の形（代替）', missing: '未登録（代替表示）' } as const;

/**
 * 機種カタログ（docs/16_aircraft_catalog.md）: 検索・メーカー/サイズでの絞り込み、詳細（値の出典と状態）、
 * 現在の空港での適合性（aircraft/compat.ts の判定をそのまま表示）、航空会社の保有機材と座席構成。
 */
export function CatalogPanel() {
  const layout = useLayout();
  const [query, setQuery] = useState('');
  const [maker, setMaker] = useState('');
  const [size, setSize] = useState<SizeClass | ''>('');
  const [selected, setSelected] = useState('B777-300ER');
  const net = useMemo(() => buildAirsideNetwork(layout), [layout]);
  const q = query.trim().toLowerCase();
  const list = AIRCRAFT_MODELS.filter(
    (m) =>
      (!maker || m.manufacturer === maker) &&
      (!size || AIRCRAFT_TYPES[m.id]!.size === size) &&
      (!q || `${m.name} ${m.id} ${m.icao ?? ''} ${m.family}`.toLowerCase().includes(q)),
  );
  const compat = useMemo(() => Object.fromEntries(AIRCRAFT_MODELS.map((m) => [m.id, checkAirport(AIRCRAFT_TYPES[m.id]!, layout, net)])), [layout, net]);
  const model = CATALOG[selected];

  return (
    <div className="issues mgmt" data-testid="catalog-panel">
      <div className="issues-header">
        <strong>機種カタログ</strong>
        <span className="muted">カタログ版 {CATALOG_VERSION}</span>
        <input placeholder="機種名・ICAO で検索" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="catalog-search" />
        <select value={maker} onChange={(e) => setMaker(e.target.value)} data-testid="catalog-maker">
          <option value="">すべてのメーカー</option>
          {MANUFACTURERS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select value={size} onChange={(e) => setSize(e.target.value as SizeClass | '')}>
          <option value="">すべての区分</option>
          <option value="S">S</option>
          <option value="M">M</option>
          <option value="L">L</option>
        </select>
        <span className="muted">寸法・重量・座席は公開資料の値（出典つき）。性能・作業時間・費用はゲーム用の値</span>
      </div>
      <div className="issues-list mgmt-grid">
        <section>
          <table className="board" data-testid="catalog-list">
            <thead>
              <tr>
                <th>機種</th>
                <th>ICAO</th>
                <th>区分</th>
                <th>翼幅</th>
                <th>既定座席</th>
                <th>この空港</th>
              </tr>
            </thead>
            <tbody>
              {list.map((m) => {
                const t = AIRCRAFT_TYPES[m.id]!;
                const c = compat[m.id]!;
                return (
                  <tr key={m.id} className={selected === m.id ? 'selected' : ''} onClick={() => setSelected(m.id)} data-testid={`catalog-row-${m.id}`}>
                    <td>
                      {m.name}
                      {m.generic ? <span className="muted"> （旧形式の汎用機材）</span> : null}
                    </td>
                    <td>{m.icao ?? '—'}</td>
                    <td>
                      {t.size}
                      {m.wingspanM.value !== null && !m.generic ? `（コード${codeLetterOf(m.wingspanM.value)}）` : ''}
                    </td>
                    <td className="num">{m.wingspanM.value ?? '—'} m</td>
                    <td className="num">{m.defaultSeats}</td>
                    <td className={c.status === 'ok' ? 'ok-text' : c.status === 'ng' ? 'ng-text' : 'warn-text'}>{COMPAT_STATUS_LABEL[c.status]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <FleetEditor />
          <AssetSupport />
        </section>
        <section>{model ? <ModelDetail m={model} /> : <div className="empty">機種を選んでください</div>}</section>
      </div>
    </div>
  );
}

function V<T>({ v, unit = '' }: { v: Sourced<T>; unit?: string }) {
  const src = v.source ? DATA_SOURCES[v.source] : undefined;
  return (
    <>
      <td className="num">{v.value === null ? '—' : `${typeof v.value === 'number' ? v.value.toLocaleString('ja-JP') : String(v.value)}${unit}`}</td>
      <td>
        <span className={`badge ${v.status}`}>{DATA_STATUS_LABEL[v.status]}</span>
      </td>
      <td className="muted small">
        {v.note}
        {src && (
          <>
            {' — '}
            <a href={src.url} target="_blank" rel="noreferrer">
              {src.publisher}
            </a>
            （参照 {src.accessed}）
          </>
        )}
      </td>
    </>
  );
}

function ModelDetail({ m }: { m: AircraftModel }) {
  const layout = useLayout();
  const net = useMemo(() => buildAirsideNetwork(layout), [layout]);
  const t = AIRCRAFT_TYPES[m.id]!;
  const c = checkAirport(t, layout, net);
  const need = requiredRunwayM(t);
  const max = maxSeatsOf(m.id);
  const rows: [string, Sourced<unknown>, string][] = [
    ['全長', m.lengthM, ' m'],
    ['翼幅', m.wingspanM, ' m'],
    ['全高', m.heightM, ' m'],
    ['最大離陸重量', m.mtowKg, ' kg'],
    ['最大旅客定員', m.maxPax, ' 人'],
    ['標準座席数', m.typicalSeats, ''],
    ['貨物室容積', m.cargoM3, ' m³'],
    ['燃料容量', m.fuelL, ' L'],
  ];
  return (
    <div data-testid="catalog-detail">
      <h4>
        {m.name} <span className="muted small">ID: {m.id} ／ {m.manufacturer} {m.family} {m.variant}</span>
      </h4>
      <table className="board">
        <tbody>
          {rows.map(([label, v, unit]) => (
            <tr key={label}>
              <td>{label}</td>
              <V v={v} unit={unit} />
            </tr>
          ))}
        </tbody>
      </table>
      <h4>ゲーム内の設定値（実機の値ではない）</h4>
      <div className="muted small">
        既定座席 {m.defaultSeats}（上限 {max.max}
        {max.official ? '・最大旅客定員' : '・ゲーム上の上限'}）／ 最小折り返し {Math.round(t.turnaroundSec / 60)}分 ／ 必要滑走路長 離陸 {need.takeoff} m・着陸 {need.landing} m ／
        貨物室の手荷物 {t.holdBags}個 ／ 運航費 {t.costPerBlockHour.toLocaleString('ja-JP')} cr/時 ／ 3D アセット {m.assetId}
      </div>
      <AssetInfo m={m} />
      <h4>
        この空港での適合性: <span className={c.status === 'ok' ? 'ok-text' : 'ng-text'}>{COMPAT_STATUS_LABEL[c.status]}</span>
      </h4>
      {c.reasons.length > 0 && (
        <ul className="plan-issues" data-testid="catalog-compat-reasons">
          {c.reasons.map((r) => (
            <li key={r} className="ng-text">
              {COMPAT_REASON_LABEL[r]}
            </li>
          ))}
        </ul>
      )}
      <table className="board" data-testid="catalog-compat">
        <tbody>
          {[...c.runways, ...c.stands, ...c.gates].map((x) => (
            <tr key={x.id}>
              <td>{displayName(layout, x.id)}</td>
              <td className={x.status === 'ok' ? 'ok-text' : x.status === 'ng' ? 'ng-text' : 'warn-text'}>{COMPAT_STATUS_LABEL[x.status]}</td>
              <td className="muted small">{x.reasons.map((r) => COMPAT_REASON_LABEL[r]).join('、')}</td>
            </tr>
          ))}
          <tr>
            <td>地上支援</td>
            <td className={c.ground.status === 'ok' ? 'ok-text' : 'ng-text'}>{COMPAT_STATUS_LABEL[c.ground.status]}</td>
            <td className="muted small">
              {c.ground.reasons.map((r) => COMPAT_REASON_LABEL[r]).join('、')}
              {c.ground.detail?.length ? `（${c.ground.detail.join(', ')}）` : ''}
            </td>
          </tr>
          {c.taxiwaysNg.length > 0 && (
            <tr>
              <td>誘導路</td>
              <td className="warn-text">一部不適合</td>
              <td className="muted small">{c.taxiwaysNg.length}区間（{[...new Set(c.taxiwaysNg.flatMap((x) => x.reasons))].map((r) => COMPAT_REASON_LABEL[r]).join('、')}）</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="muted small">適合性はゲームで採用した簡略化ルールで、実際の空港運用・安全基準への適合を示すものではありません。</div>
    </div>
  );
}

/** 航空会社の保有機材と座席構成 */
function FleetEditor() {
  const c = useCompany();
  const [airline, setAirline] = useState(AIRLINES[0]!.id);
  const [typeId, setTypeId] = useState('A320neo');
  const [seats, setSeats] = useState(180);
  const fleet = c.fleets?.[airline] ?? [];
  return (
    <div data-testid="fleet-editor">
      <h4>航空会社の保有機材と座席構成</h4>
      <div className="fee-grid">
        <select value={airline} onChange={(e) => setAirline(e.target.value)} data-testid="fleet-airline">
          {AIRLINES.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name}
            </option>
          ))}
        </select>
      </div>
      <table className="board">
        <tbody>
          {fleet.map((e) => (
            <tr key={e.typeId}>
              <td>{AIRCRAFT_TYPES[e.typeId]?.label ?? `未解決の機種（${e.typeId}）`}</td>
              <td className="num">{e.seats}席</td>
              <td>
                <button onClick={() => companyActions.removeFleetEntry(airline, e.typeId)}>外す</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fee-grid">
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)} data-testid="fleet-type">
          {AIRCRAFT_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <input type="number" min={1} value={seats} onChange={(e) => setSeats(Number(e.target.value))} data-testid="fleet-seats" style={{ width: 70 }} />
        <button onClick={() => companyActions.setFleetEntry(airline, typeId, seats)} data-testid="fleet-add">
          追加・座席数を変更
        </button>
      </div>
      <div className="muted small">同じ機種でも航空会社ごとに座席数を変えられます（上限は最大旅客定員。資料で確認できない機種は既定座席の1.25倍）。</div>
    </div>
  );
}

/** 選択中の機種の 3D アセット（登録簿の内容） */
function AssetInfo({ m }: { m: AircraftModel }) {
  const a = assetOf(m.assetId);
  const level = supportList({ [m.id]: m })[0]!.level;
  return (
    <div className="muted small" data-testid="catalog-asset">
      3D: {a.label}（{a.id} v{a.version}）／ {SUPPORT_LABEL[level]} ／ 原点 機体中心・接地面、1単位 = 1 m ／ LOD {a.lod.length}段階（
      {a.lod.map((l) => `${l.detail}${Number.isFinite(l.maxDistanceM) ? `<${l.maxDistanceM}m` : ''}`).join('・')}）／ 出典 {a.source} ／ ライセンス {a.license}
    </div>
  );
}

/** 3D 表示の対応状況（全機種） */
function AssetSupport() {
  const rows = supportList(CATALOG);
  const count = (k: keyof typeof SUPPORT_LABEL) => rows.filter((r) => r.level === k).length;
  return (
    <div data-testid="asset-support">
      <h4>3D 表示の対応状況（アセット版 {ASSET_VERSION}）</h4>
      <div className="muted small">
        専用モデル {count('dedicated')} ／ 系統テンプレート {count('template')} ／ 汎用の形 {count('fallback')} ／ 未登録 {count('missing')}。
        専用の精密モデルはなく、すべて手続き生成（寸法は機種カタログの値）。塗装は架空の航空会社 {Object.keys(LIVERIES).length} 社分。
      </div>
      <table className="board">
        <tbody>
          {rows.map((r) => (
            <tr key={r.modelId}>
              <td>{r.modelId}</td>
              <td>{r.assetId}</td>
              <td className={r.level === 'missing' ? 'ng-text' : r.level === 'fallback' ? 'warn-text' : ''}>{SUPPORT_LABEL[r.level]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
