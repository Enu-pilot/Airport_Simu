import { DOOR_SILL_M, DOOR_SILL_UPPER_M, PBB_TYPES, type PbbBridgeType } from '../core/model/catalog';
import { boardingProfile, pbbForGate } from '../core/model/boardingBridge';
import { gateMode } from '../core/model/gates';
import { updateEntity } from '../core/layout/operations';
import { actions, applyOp } from '../editor/store';
import { PBB_DECK_LABEL, PBB_TYPE_LABEL } from '../i18n/ja';
import type { AirportLayout, Facility } from '../core/model/types';

/**
 * ゲートのプロパティに出す搭乗橋（PBB）節（機能H、design-GHIJ-detail.md §H.5）。
 * 読み取りの正は core/model/boardingBridge（pbbForGate / boardingProfile）。
 * 型式の変更は PBB 施設の props を updateEntity で書き換える。
 * ドアシル高は機種カタログに実値が無いため SizeClass からのゲーム値（UI でもゲーム値と明示する）。
 */

const update = (layout: AirportLayout, id: string, patch: Record<string, unknown>) => applyOp(updateEntity(layout, id, patch));

const fmtSpeed = (boardSec: number, deplane: number): string =>
  `搭乗 ${Math.round(boardSec * 10) / 10} 秒/人・降機 ${Math.round(deplane * 10) / 10} 人/分`;

export function GatePbbSection({ layout, gate }: { layout: AirportLayout; gate: Facility }) {
  if (gateMode(gate) === 'bus') return null;
  const standId = typeof gate.props.standId === 'string' ? gate.props.standId : null;
  const stand = standId ? layout.stands[standId] : undefined;
  const units = pbbForGate(layout, gate.id);
  const synthesized = units.length > 0 && units[0]!.synthesized;
  // 実効速度は「紐付くスポットに就航しうる最大区分」で代表させる
  const size = stand?.size ?? 'M';
  const profile = boardingProfile(layout, gate.id, { size, doubleDeck: false });
  const profileDD = boardingProfile(layout, gate.id, { size, doubleDeck: true });

  return (
    <div className="pbb-section" data-testid="gate-pbb-section">
      <div className="tool-group-title">
        <span>搭乗橋（PBB）</span>
        <span className="tool-group-count">{units.length} 基</span>
      </div>
      {units.length === 0 && <div className="muted small">搭乗橋はありません（タラップ搭乗: {fmtSpeed(profile.boardSecPerPax, profile.deplanePerMin)}）</div>}
      {synthesized && (
        <div className="muted small" data-testid="pbb-synthesized">
          従来の橋（tunnel1 相当）で計算中です。明示の搭乗橋（PBB）を配置すると型式・本数を選べます。
        </div>
      )}
      {units.map((u) => {
        const spec = PBB_TYPES[u.bridgeType];
        const perDeck = u.deck === 'upper'
          ? { board: spec.boardSecPerPax.upper, deplane: spec.deplanePerMin.upper, sill: spec.sillUpper }
          : { board: spec.boardSecPerPax.main, deplane: spec.deplanePerMin.main, sill: spec.sillMain };
        return (
          <div key={u.facilityId ?? 'synthesized'} className="muted small" data-testid={`pbb-unit-${u.deck}`}>
            <strong>{PBB_TYPE_LABEL[u.bridgeType]}</strong>・{PBB_DECK_LABEL[u.deck]}
            {u.synthesized ? '（互換合成）' : u.buildState !== 'operational' ? '（未完成のため無効）' : ''}
            <br />
            ドアシル高の適合範囲 {perDeck.sill ? `${perDeck.sill.min}〜${perDeck.sill.max} m` : 'なし'}（ゲーム値）
            {perDeck.board !== undefined && perDeck.deplane !== undefined && (
              <>
                <br />
                {fmtSpeed(perDeck.board, perDeck.deplane)}・建設費 {spec.cost.toLocaleString()} cr
              </>
            )}
            {!u.synthesized && u.facilityId && (
              <>
                <br />
                <select
                  value={u.bridgeType}
                  onChange={(e) => update(layout, u.facilityId!, { props: { bridgeType: e.target.value as PbbBridgeType } })}
                  data-testid={`pbb-type-${u.deck}`}
                >
                  {Object.entries(PBB_TYPE_LABEL).map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>{' '}
                <button className="small" onClick={() => actions.select(u.facilityId)} data-testid={`pbb-select-${u.deck}`}>
                  この橋を選択
                </button>
              </>
            )}
          </div>
        );
      })}
      {stand && (
        <div className="muted small">
          紐付くスポット（{stand.size} 区分）のドアシル高 {DOOR_SILL_M[stand.size]} m（ゲーム値）
          {stand.size === 'L' && <>・2階建て機の上デッキ {DOOR_SILL_UPPER_M} m（ゲーム値）</>}
          <br />
          実効速度（{size} 区分）: {fmtSpeed(profile.boardSecPerPax, profile.deplanePerMin)}
          {profile.sillOver && '（ドア高が型式の範囲外のため速度ペナルティ中）'}
          {stand.size === 'L' && profileDD.decks.includes('upper') && (
            <>
              <br />
              実効速度（2階建て機・上下並行）: {fmtSpeed(profileDD.boardSecPerPax, profileDD.deplanePerMin)}
            </>
          )}
        </div>
      )}
      <button
        className="small"
        onClick={() => {
          actions.setTool('pbb');
          actions.setDraft({ kind: 'pbb', gateId: gate.id });
        }}
        data-testid="pbb-add"
      >
        PBB を追加（続けてスポットをクリック）
      </button>
    </div>
  );
}
