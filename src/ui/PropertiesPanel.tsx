import { useState, type ReactNode } from 'react';
import { FACILITY_SPECS, PROP_SCHEMAS, TERMINAL_AREA_SPECS, TILE_M } from '../core/model/catalog';
import { sortedValues } from '../core/model/ids';
import {
  BUILD_STATES,
  HEADINGS,
  entityTypeOf,
  type AirportLayout,
  type BuildState,
  type Rotation,
} from '../core/model/types';
import { distance } from '../core/geometry/vec';
import { facilityDims, standEntry } from '../core/layout/footprint';
import { edgesOfNode } from '../core/layout/network';
import {
  deleteEntity,
  duplicateEntity,
  reverseEdge,
  rotateEntity,
  updateEntity,
} from '../core/layout/operations';
import { runwayDesignators, runwayEnd, runwayLengthClass, runwayLengthM, runwayMaxSize } from '../core/layout/runway';
import { applyOp, editorStore, useAnalysis, useEditor, useLayout } from '../editor/store';
import { ops } from '../editor/simRunner';
import { areaOccupancy, facilityLoad } from '../core/sim/passengers';
import { focusEntity } from '../editor/input';
import {
  BUILD_STATE_LABEL,
  ENTITY_LABEL,
  FACILITY_LABEL,
  NODE_KIND_LABEL,
  OPERABILITY_LABEL,
  PROP_LABEL,
  ROAD_CLASS_LABEL,
  SIZE_LABEL,
  displayName,
  issueText,
  AREA_KIND_LABEL,
  AREA_PROP_LABEL,
  ZONE_LABEL,
} from '../i18n/ja';

export function PropertiesPanel() {
  const selection = useEditor((s) => s.selection);
  const mode = useEditor((s) => s.mode);
  const layout = useLayout();
  if ((!selection || !entityTypeOf(selection)) && mode === 'operate') {
    return (
      <div className="properties empty" data-testid="properties">
        <p>運航中です。機体をクリック（または運航表の行を選択）すると状態・経路・運航履歴を表示します。</p>
        <ul className="help">
          <li>Space: 一時停止 / 再開</li>
          <li>1〜5: 時間倍率（実時間〜×600）</li>
          <li>右ドラッグ・中ドラッグ: パン / ホイール: ズーム</li>
          <li>「論理ネットワーク・予約」表示で、各機が予約中の誘導路を色分け表示</li>
          <li>滑走路の枠: 赤 = 使用中、黄 = 進入予約あり</li>
          <li>運航中はレイアウトを編集できません</li>
        </ul>
      </div>
    );
  }
  if (!selection || !entityTypeOf(selection)) {
    return (
      <div className="properties empty" data-testid="properties">
        <p>施設を選択するとプロパティを表示・編集できます。</p>
        <ul className="help">
          <li>左クリック: 選択 / ドラッグ: 移動</li>
          <li>右ドラッグ・中ドラッグ・Space+ドラッグ: パン</li>
          <li>ホイール: ズーム</li>
          <li>R: 回転 / Ctrl+D: 複製 / Delete: 削除</li>
          <li>Ctrl+Z: 元に戻す / Ctrl+Shift+Z・Ctrl+Y: やり直し</li>
          <li>矢印: 1タイル移動（Shift で10）/ Esc: 解除</li>
        </ul>
      </div>
    );
  }
  return (
    <div className="properties" data-testid="properties" key={selection}>
      <EntityProperties layout={layout} id={selection} />
    </div>
  );
}

const update = (layout: AirportLayout, id: string, patch: Record<string, unknown>) => applyOp(updateEntity(layout, id, patch));

function EntityProperties({ layout, id }: { layout: AirportLayout; id: string }) {
  const analysis = useAnalysis();
  const type = entityTypeOf(id)!;
  const issues = analysis.byTarget[id] ?? [];
  const op = analysis.operability[id];
  const canTransform = type === 'facility' || type === 'stand' || type === 'runway' || type === 'terminalArea';
  const buildState = (layout.runways[id] ?? layout.taxiways[id] ?? layout.roads[id] ?? layout.stands[id] ?? layout.facilities[id])?.buildState;
  const typeLabel = type === 'facility' ? FACILITY_LABEL[layout.facilities[id]!.kind] : ENTITY_LABEL[type];

  return (
    <>
      <div className="prop-header">
        <div className="prop-title" data-testid="prop-title">{displayName(layout, id)}</div>
        <div className="prop-sub">
          {typeLabel} · <code>{id}</code>
        </div>
      </div>

      <div className="prop-actions">
        {canTransform && (
          <>
            <button onClick={() => applyOp(rotateEntity(layout, id))} title="R">回転</button>
            <button onClick={() => applyOp(duplicateEntity(layout, id), { select: true })} title="Ctrl+D">複製</button>
          </>
        )}
        <button className="danger" onClick={() => applyOp(deleteEntity(layout, id))} title="Delete" data-testid="prop-delete">
          削除
        </button>
      </div>

      {op && (
        <div className={op.operable ? 'operability ok' : 'operability ng'} data-testid="operability">
          {op.operable ? '✔ 運用可能' : '✖ 運用不可'}
          {op.reasons.map((r) => (
            <div key={r} className="reason">
              ・{OPERABILITY_LABEL[r]}
            </div>
          ))}
        </div>
      )}

      <Section title="基本">
        {buildState && (
          <Field label="建設状態">
            <select value={buildState} onChange={(e) => update(layout, id, { buildState: e.target.value as BuildState })} data-testid="prop-buildState">
              {BUILD_STATES.map((b) => (
                <option key={b} value={b}>
                  {BUILD_STATE_LABEL[b]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <TypeFields layout={layout} id={id} />
      </Section>

      {issues.length > 0 && (
        <Section title={`問題（${issues.length}）`}>
          {issues.map((iss) => (
            <div key={iss.key} className={`issue ${iss.severity}`}>
              {issueText(layout, iss)}
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

function TypeFields({ layout, id }: { layout: AirportLayout; id: string }) {
  const analysis = useAnalysis();
  const net = analysis.network;
  const type = entityTypeOf(id);

  if (type === 'runway') {
    const r = layout.runways[id]!;
    const [d0, d1] = runwayDesignators(r.heading);
    const entries = (net.runwayNodes[id] ?? []).filter((n) => layout.taxiNodes[n]);
    return (
      <>
        <NameField layout={layout} id={id} value={r.name} />
        <Field label="向き（始点→終点）">
          <select value={r.heading} onChange={(e) => update(layout, id, { heading: Number(e.target.value) })} data-testid="prop-heading">
            {HEADINGS.map((h) => (
              <option key={h} value={h}>
                {h}°（{runwayDesignators(h).join('/')}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="長さ（タイル）">
          <NumberInput value={r.length} min={1} max={200} onCommit={(v) => update(layout, id, { length: v })} testid="prop-length" />
        </Field>
        <Field label="舗装幅">
          <select value={r.surfaceWidthM} onChange={(e) => update(layout, id, { surfaceWidthM: Number(e.target.value) })}>
            <option value={30}>30m（S級まで）</option>
            <option value={45}>45m（M級まで）</option>
            <option value={60}>60m（L級まで）</option>
          </select>
        </Field>
        <Info label="滑走路番号">{`${d0}/${d1}`}</Info>
        <Info label="実長">{`${runwayLengthM(r).toLocaleString()} m`}</Info>
        <Info label="長さによる区分">{runwayLengthClass(r) ?? '使用不可'}</Info>
        <Info label="使用可能な機体" testid="prop-maxSize">{runwayMaxSize(r) ? `${runwayMaxSize(r)}級まで` : '使用不可'}</Info>
        <Info label="始点 / 終点">{`(${r.start.x}, ${r.start.y}) → (${runwayEnd(r).x}, ${runwayEnd(r).y})`}</Info>
        <Info label="滑走路入口">
          {entries.length === 0 ? 'なし' : entries.map((n) => <EntityLink key={n} layout={layout} id={n} />)}
        </Info>
      </>
    );
  }

  if (type === 'taxiway') {
    const e = layout.taxiways[id]!;
    const a = layout.taxiNodes[e.from]!;
    const b = layout.taxiNodes[e.to]!;
    return (
      <>
        <NameField layout={layout} id={id} value={e.name} />
        <Field label="誘導路幅（最大機体）">
          <select value={e.widthClass} onChange={(ev) => update(layout, id, { widthClass: ev.target.value })} data-testid="prop-widthClass">
            {(['S', 'M', 'L'] as const).map((s) => (
              <option key={s} value={s}>
                {SIZE_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="一方通行">
          <input type="checkbox" checked={e.oneWay} onChange={(ev) => update(layout, id, { oneWay: ev.target.checked })} />
          {e.oneWay && (
            <button className="small" onClick={() => applyOp(reverseEdge(layout, id))}>
              向きを反転
            </button>
          )}
        </Field>
        <Info label="区間">
          <EntityLink layout={layout} id={e.from} /> {e.oneWay ? '→' : '↔'} <EntityLink layout={layout} id={e.to} />
        </Info>
        <Info label="長さ">{`${Math.round(distance(a.pos, b.pos) * TILE_M)} m`}</Info>
        {net.edges[id]?.holdShortAt && <Info label="停止位置">滑走路手前で停止（ホールディングポイント）</Info>}
      </>
    );
  }

  if (type === 'road') {
    const e = layout.roads[id]!;
    return (
      <>
        <NameField layout={layout} id={id} value={e.name} />
        <Field label="種別">
          <select value={e.roadClass} onChange={(ev) => update(layout, id, { roadClass: ev.target.value })}>
            <option value="public">{ROAD_CLASS_LABEL.public}</option>
            <option value="service">{ROAD_CLASS_LABEL.service}</option>
          </select>
        </Field>
        <Field label="一方通行">
          <input type="checkbox" checked={e.oneWay} onChange={(ev) => update(layout, id, { oneWay: ev.target.checked })} />
        </Field>
      </>
    );
  }

  if (type === 'taxiNode' || type === 'roadNode') {
    const n = layout.taxiNodes[id] ?? layout.roadNodes[id]!;
    const edges: { id: string }[] = type === 'taxiNode' ? edgesOfNode(layout.taxiways, id) : edgesOfNode(layout.roads, id);
    const an = net.nodes[id];
    return (
      <>
        <NameField layout={layout} id={id} value={n.name} />
        <Info label="位置">{`(${n.pos.x}, ${n.pos.y})`}</Info>
        {an && <Info label="種類">{NODE_KIND_LABEL[an.kind]}</Info>}
        {an?.kind === 'runwayEntry' && (
          <Field label="停止義務（ホールディングポイント）">
            <input type="checkbox" checked={n.holdShort} onChange={(e) => update(layout, id, { holdShort: e.target.checked })} data-testid="prop-holdShort" />
          </Field>
        )}
        {an && an.runwayIds.length > 0 && (
          <Info label="滑走路">
            {an.runwayIds.map((r) => (
              <EntityLink key={r} layout={layout} id={r} />
            ))}
          </Info>
        )}
        <Info label={`接続（${edges.length}）`}>
          {edges.map((e) => (
            <EntityLink key={e.id} layout={layout} id={e.id} />
          ))}
        </Info>
        {an && an.standIds.length > 0 && (
          <Info label="スポット">
            {an.standIds.map((s) => (
              <EntityLink key={s} layout={layout} id={s} />
            ))}
          </Info>
        )}
      </>
    );
  }

  if (type === 'stand') {
    const s = layout.stands[id]!;
    const link = net.standLinks[id];
    const gates = sortedValues(layout.facilities).filter((f) => f.kind === 'gate' && f.props.standId === id);
    const entry = standEntry(s);
    return (
      <>
        <NameField layout={layout} id={id} value={s.name} />
        <Field label="サイズ">
          <select value={s.size} onChange={(e) => update(layout, id, { size: e.target.value })} data-testid="prop-size">
            {(['S', 'M', 'L'] as const).map((z) => (
              <option key={z} value={z}>
                {SIZE_LABEL[z]}
              </option>
            ))}
          </select>
        </Field>
        <RotationField value={s.rotation} onChange={(r) => update(layout, id, { rotation: r })} label="機首の向き" />
        <Info label="位置">{`(${s.origin.x}, ${s.origin.y})`}</Info>
        <Info label="入口">{`(${entry.x}, ${entry.y})`}</Info>
        <Info label="誘導路接続">{link ? <EntityLink layout={layout} id={link} /> : <span className="ng-text">未接続</span>}</Info>
        <Info label="ゲート">{gates.length === 0 ? 'なし（リモート）' : gates.map((g) => <EntityLink key={g.id} layout={layout} id={g.id} />)}</Info>
      </>
    );
  }

  if (type === 'terminalArea') {
    const a = layout.terminalAreas[id]!;
    const spec = TERMINAL_AREA_SPECS[a.kind];
    const terminal = layout.facilities[a.terminalId];
    const levels = Number(terminal?.props.levels ?? 1);
    const node = analysis.terminal.areas[id];
    const links = (analysis.terminal.links[id] ?? []).map((l) => l.to);
    return (
      <>
        <NameField layout={layout} id={id} value={a.name} />
        <Info label="種類">{AREA_KIND_LABEL[a.kind]}</Info>
        <Field label="階">
          <select value={a.level} onChange={(e) => update(layout, id, { level: Number(e.target.value) })} data-testid="prop-level">
            {Array.from({ length: levels }, (_, l) => (
              <option key={l} value={l}>
                {l + 1}F
              </option>
            ))}
          </select>
        </Field>
        <Field label="区域">
          {spec.zoneEditable ? (
            <select value={a.zone} onChange={(e) => update(layout, id, { zone: e.target.value })}>
              {(['landside', 'departure', 'arrival'] as const).map((z) => (
                <option key={z} value={z}>
                  {ZONE_LABEL[z]}
                </option>
              ))}
            </select>
          ) : (
            ZONE_LABEL[a.zone]
          )}
        </Field>
        <Field label="幅（タイル）">
          <NumberInput value={a.w} min={spec.minW} max={150} onCommit={(v) => update(layout, id, { w: v })} />
        </Field>
        <Field label="奥行き（タイル）">
          <NumberInput value={a.h} min={spec.minH} max={150} onCommit={(v) => update(layout, id, { h: v })} />
        </Field>
        {spec.props.map((def) =>
          def.type === 'int' ? (
            <Field key={def.key} label={AREA_PROP_LABEL[def.key] ?? def.key}>
              <NumberInput value={Number(a.props[def.key])} min={def.min} max={def.max} onCommit={(v) => update(layout, id, { props: { [def.key]: v } })} testid={`prop-${def.key}`} />
            </Field>
          ) : null,
        )}
        {node && <Info label="混雑の目安">{`${node.capacity} 人`}</Info>}
        <Info label={`接続（${links.length}）`}>
          {links.length === 0 ? <span className="ng-text">どこにも接していません</span> : links.map((l) => <EntityLink key={l} layout={layout} id={l} />)}
        </Info>
        <AreaOpsSection id={id} />
      </>
    );
  }

  if (type === 'facility') {
    const f = layout.facilities[id]!;
    const spec = FACILITY_SPECS[f.kind];
    const dims = facilityDims(f);
    return (
      <>
        <NameField layout={layout} id={id} value={f.name} />
        <Info label="位置">{`(${f.origin.x}, ${f.origin.y})`}</Info>
        {spec.resizable ? (
          <>
            <Field label="幅（タイル）">
              <NumberInput value={f.w} min={spec.minW} max={150} onCommit={(v) => update(layout, id, { w: v })} testid="prop-w" />
            </Field>
            <Field label="奥行き（タイル）">
              <NumberInput value={f.h} min={spec.minH} max={150} onCommit={(v) => update(layout, id, { h: v })} testid="prop-h" />
            </Field>
          </>
        ) : (
          <Info label="大きさ">{`${dims.w} × ${dims.h} タイル`}</Info>
        )}
        {f.kind !== 'gate' && <RotationField value={f.rotation} onChange={(r) => update(layout, id, { rotation: r })} label="向き" />}
        {PROP_SCHEMAS[f.kind].map((def) => (
          <Field key={def.key} label={PROP_LABEL[def.key] ?? def.key}>
            {def.type === 'int' && (
              <NumberInput
                value={f.props[def.key] as number}
                min={def.min}
                max={def.max}
                onCommit={(v) => update(layout, id, { props: { [def.key]: v } })}
                testid={`prop-${def.key}`}
              />
            )}
            {def.type === 'bool' && (
              <input type="checkbox" checked={!!f.props[def.key]} onChange={(e) => update(layout, id, { props: { [def.key]: e.target.checked } })} />
            )}
            {def.type === 'enum' && (
              <select value={String(f.props[def.key])} onChange={(e) => update(layout, id, { props: { [def.key]: e.target.value } })}>
                {def.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            )}
            {def.type === 'standRef' && (
              <select
                value={(f.props[def.key] as string | null) ?? ''}
                onChange={(e) => update(layout, id, { props: { [def.key]: e.target.value || null } })}
                data-testid={`prop-${def.key}`}
              >
                <option value="">（なし）</option>
                {sortedValues(layout.stands).map((s) => (
                  <option key={s.id} value={s.id}>
                    {displayName(layout, s.id)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ))}
      </>
    );
  }
  return null;
}

// ---------------------------------------------------------------- 部品

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="prop-section">
      <div className="prop-section-title">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="prop-field">
      <span className="prop-label">{label}</span>
      <span className="prop-value">{children}</span>
    </label>
  );
}

function Info({ label, children, testid }: { label: string; children: ReactNode; testid?: string }) {
  return (
    <div className="prop-field">
      <span className="prop-label">{label}</span>
      <span className="prop-value info" data-testid={testid}>
        {children}
      </span>
    </div>
  );
}

function EntityLink({ layout, id }: { layout: AirportLayout; id: string }) {
  return (
    <button className="link" onClick={() => focusEntity(id)}>
      {displayName(layout, id)}
    </button>
  );
}

function NameField({ layout, id, value }: { layout: AirportLayout; id: string; value: string }) {
  return (
    <Field label="名前">
      <TextInput value={value} onCommit={(v) => update(layout, id, { name: v })} testid="prop-name" />
    </Field>
  );
}

function RotationField({ value, onChange, label }: { value: Rotation; onChange: (r: Rotation) => void; label: string }) {
  const names: Record<Rotation, string> = { 0: '北（0°）', 90: '東（90°）', 180: '南（180°）', 270: '西（270°）' };
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(Number(e.target.value) as Rotation)} data-testid="prop-rotation">
        {([0, 90, 180, 270] as const).map((r) => (
          <option key={r} value={r}>
            {names[r]}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Enter またはフォーカスアウトで確定するテキスト入力（1回の確定 = 1回の履歴） */
function TextInput({ value, onCommit, testid }: { value: string; onCommit: (v: string) => void; testid?: string }) {
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

function NumberInput({ value, min, max, onCommit, testid }: { value: number; min: number; max: number; onCommit: (v: number) => void; testid?: string }) {
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

/** 運航中の施設の状況と閉鎖・再開 */
function AreaOpsSection({ id }: { id: string }) {
  useEditor((s) => s.ops?.uiVersion ?? -1);
  const o = editorStore.getState().ops;
  if (!o) return null;
  const st = o.sim.state;
  const closed = st.closedAreas.includes(id);
  const fac = st.facilities[id];
  const load = facilityLoad(st, id);
  const here = areaOccupancy(st).get(id) ?? 0;
  return (
    <div className="prop-section" data-testid="area-ops">
      <div className="prop-section-title">運用状況</div>
      <Info label="滞在中">{`${here} 人`}</Info>
      <Info label="待ち / 手続き中">{`${load.queued} 人 / ${load.inService} 人`}</Info>
      {fac && <Info label="処理済み / 平均待ち">{`${fac.served} 人 / ${fac.served ? Math.round(fac.waitTotal / fac.served / 6) / 10 : 0} 分`}</Info>}
      <button className={closed ? 'primary' : 'danger'} onClick={() => ops.setAreaClosed(id, !closed)} data-testid="toggle-area">
        {closed ? '再開する' : '閉鎖する'}
      </button>
    </div>
  );
}
