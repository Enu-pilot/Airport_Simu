import { useState, useSyncExternalStore } from 'react';
import { CLIMATES, DIFFICULTIES, defaultGame, type GameSettings } from '../core/economy/game';
import { CITY_TYPES, defaultCity, defaultCityNightOps, type CityType } from '../core/economy/city';
import { editorStore, newGame, setCompanyCity, setCompanyFeatures, setCompanyMarket, setGameSettings } from '../editor/store';
import { isUnlocked, lockLabel } from '../core/economy/unlocks';
import type { CompanyState } from '../core/economy/company';

type FeatureKey = keyof NonNullable<CompanyState['features']>;
import { GAME_UI, MODE_LABEL } from '../i18n/ja';

/** ゲーム設定ダイアログの表示状態（表示だけの状態。保存しない） */
type Open = 'new' | 'settings' | null;
let openState: Open = null;
const listeners = new Set<() => void>();
export const gameSetupUi = {
  open(k: 'new' | 'settings'): void {
    openState = k;
    for (const l of listeners) l();
  },
  close(): void {
    openState = null;
    for (const l of listeners) l();
  },
};
const useOpen = (): Open =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => openState,
  );

/**
 * 新しいゲーム（難易度・気候・使うルールを選んで開始）と、既存の会社のゲーム設定の付け外し（建設モード）。
 */
export function GameSetupDialog() {
  const open = useOpen();
  if (!open) return null;
  return <Dialog key={open} kind={open} />;
}

function Dialog({ kind }: { kind: 'new' | 'settings' }) {
  const currentCompany = editorStore.getState().company;
  const current = currentCompany.game;
  const [legacy, setLegacy] = useState(kind === 'settings' && !current);
  const [g, setG] = useState<GameSettings>(current ?? defaultGame());
  const [mode, setMode] = useState<'career' | 'sandbox'>('career');
  const [cityEnabled, setCityEnabled] = useState(kind === 'new' || !!currentCompany.city);
  const [cityType, setCityType] = useState<CityType>(currentCompany.city?.type ?? 'regional');
  const [marketEnabled, setMarketEnabled] = useState(!!currentCompany.market);
  const [features, setFeatures] = useState<{ overnight?: true; based?: true; international?: true; hub?: true }>(currentCompany.features ?? {});
  const toggleFeature = (f: FeatureKey, on: boolean) => setFeatures((x) => ({ ...x, [f]: on ? true : undefined }));
  const patch = (p: Partial<GameSettings>) => setG((x) => ({ ...x, ...p }));
  const submit = () => {
    if (kind === 'new') {
      if (!window.confirm(GAME_UI.setupConfirm)) return;
      // 新規ゲームで都市を選んだときだけ、夜間の運用（最終出発時刻 21:15）を既定で有効にする。defaultCity 自体は変えない
      newGame(mode, legacy ? null : g, cityEnabled ? { ...defaultCity(cityType), nightOps: defaultCityNightOps() } : null);
      if (marketEnabled && cityEnabled) setCompanyMarket(true);
      setCompanyFeatures(features);
    } else {
      if (!window.confirm(GAME_UI.setupApplyConfirm)) return;
      setGameSettings(legacy ? null : g);
      // 既存の夜間の運用設定は引き継ぐ（なければ足さない）
      setCompanyCity(cityEnabled ? { ...defaultCity(cityType), ...(currentCompany.city?.nightOps ? { nightOps: currentCompany.city.nightOps } : {}) } : null);
      setCompanyMarket(marketEnabled && cityEnabled);
      setCompanyFeatures(features);
    }
    gameSetupUi.close();
  };
  return (
    <div className="modal-backdrop" data-testid="game-setup-dialog" role="dialog" aria-label={GAME_UI.setupDialog}>
      <div className="modal game-setup">
        <h3>{kind === 'new' ? GAME_UI.setupNew : GAME_UI.setupSettings}</h3>
        {kind === 'new' && (
          <fieldset>
            <legend>{GAME_UI.setupMode}</legend>
            {(['career', 'sandbox'] as const).map((m) => (
              <label key={m}>
                <input type="radio" name="gs-mode" checked={mode === m} onChange={() => setMode(m)} data-testid={`setup-mode-${m}`} />
                {m === 'career' ? GAME_UI.setupModeCareer : GAME_UI.setupModeSandbox}
              </label>
            ))}
          </fieldset>
        )}
        <fieldset disabled={legacy}>
          <legend>{GAME_UI.setupDifficulty}</legend>
          {DIFFICULTIES.map((d) => (
            <label key={d} className="gs-diff">
              <input type="radio" name="gs-diff" checked={g.difficulty === d} onChange={() => patch({ difficulty: d })} data-testid={`setup-difficulty-${d}`} />
              <b>{GAME_UI.difficulty[d]}</b> <span className="muted small">{GAME_UI.difficultyHint[d]}</span>
            </label>
          ))}
        </fieldset>
        <fieldset disabled={legacy}>
          <legend>{GAME_UI.setupClimate}</legend>
          {CLIMATES.map((c) => (
            <label key={c}>
              <input type="radio" name="gs-climate" checked={g.climate === c} onChange={() => patch({ climate: c })} data-testid={`setup-climate-${c}`} />
              {GAME_UI.climate[c]}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>{GAME_UI.setupCity}</legend>
          <label>
            <input type="checkbox" checked={cityEnabled} onChange={(e) => setCityEnabled(e.target.checked)} data-testid="setup-city-enabled" />
            {GAME_UI.setupCityEnabled}
          </label>
          <select value={cityType} disabled={!cityEnabled} onChange={(e) => setCityType(e.target.value as CityType)} data-testid="setup-city-type">
            {CITY_TYPES.map((type) => <option key={type} value={type}>{GAME_UI.cityType[type]}</option>)}
          </select>
          <label>
            <input type="checkbox" checked={marketEnabled} disabled={!cityEnabled} onChange={(e) => setMarketEnabled(e.target.checked)} data-testid="setup-market-enabled" />
            {GAME_UI.setupMarket}
          </label>
        </fieldset>
        <fieldset>
          <legend>{GAME_UI.setupFeatures}</legend>
          {([
            ['overnight', GAME_UI.setupFeatureOvernight],
            ['based', GAME_UI.setupFeatureBased],
            ['international', GAME_UI.setupFeatureInternational],
            ['hub', GAME_UI.setupFeatureHub],
          ] as [FeatureKey, string][]).map(([f, label]) => {
            const locked = !isUnlocked(currentCompany, f);
            return (
              <label key={f}>
                <input type="checkbox" checked={!!features[f]} disabled={locked} onChange={(e) => toggleFeature(f, e.target.checked)} data-testid={`setup-feature-${f}`} />
                {label}
                {locked && <span className="muted small">（{lockLabel(currentCompany, f)}）</span>}
              </label>
            );
          })}
        </fieldset>
        <fieldset disabled={legacy}>
          <legend>{GAME_UI.setupRules}</legend>
          <label>
            <input type="checkbox" checked={g.weather === 'levels'} onChange={(e) => patch({ weather: e.target.checked ? 'levels' : 'legacy' })} data-testid="setup-weather" />
            {GAME_UI.setupWeather}
          </label>
          <label>
            <input type="checkbox" checked={g.airlineEval} onChange={(e) => patch({ airlineEval: e.target.checked })} data-testid="setup-eval" />
            {GAME_UI.setupEval}
          </label>
          <label>
            <input type="checkbox" checked={g.goals} onChange={(e) => patch({ goals: e.target.checked })} data-testid="setup-goals" />
            {GAME_UI.setupGoals}
          </label>
        </fieldset>
        <label>
          <input type="checkbox" checked={legacy} onChange={(e) => setLegacy(e.target.checked)} data-testid="setup-legacy" />
          {GAME_UI.setupLegacy}
        </label>
        <p className="muted small">{GAME_UI.setupNote}</p>
        <div className="modal-actions">
          <button className="primary" onClick={submit} data-testid={kind === 'new' ? 'setup-start' : 'setup-apply'}>
            {kind === 'new' ? GAME_UI.setupStart : GAME_UI.setupApply}
          </button>
          <button onClick={() => gameSetupUi.close()} data-testid="setup-cancel">
            {GAME_UI.setupCancel}
          </button>
        </div>
        {kind === 'new' && <p className="muted small">{MODE_LABEL[mode]}</p>}
      </div>
    </div>
  );
}
