import { useRef, useState } from 'react';
import { CATALOG_VERSION } from '../core/aircraft/catalog';
import { ASSET_VERSION } from '../core/assets/registry';
import { PROJECT_FORMAT_VERSION, type ValidationReport } from '../core/io/project';
import { catalogDiff, SIM_MODEL_VERSION } from '../core/scenario/scenario';
import { listSlots, projectActions } from '../editor/project';
import { useEditor } from '../editor/store';

/**
 * プロジェクト（docs/21_save_format.md）: 保存スロット・名前を付けて保存・読み込み・JSON の書き出し / 読み込み、
 * 読み込み時の検証結果、機種データの固定と最新カタログとの差分。
 */
export function ProjectPanel() {
  const name = useEditor((s) => s.projectName);
  const projectId = useEditor((s) => s.projectId);
  const pin = useEditor((s) => s.catalogPin);
  const operating = useEditor((s) => s.mode === 'operate');
  // スロット一覧は保存・削除のたびに読み直す
  const [rev, setRev] = useState(0);
  const slots = listSlots();
  void rev;
  const [saveAsName, setSaveAsName] = useState('');
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const diff = pin ? catalogDiff(pin.models) : [];

  const download = () => {
    const { fileName, json } = projectActions.exportJson();
    downloadText(fileName, json);
  };

  return (
    <div className="issues mgmt" data-testid="project-panel">
      <div className="issues-header">
        <strong>プロジェクト</strong>
        <input value={name} onChange={(e) => projectActions.rename(e.target.value)} data-testid="project-name" />
        <span className="muted">{projectId ? '保存済みのスロット' : '未保存'}</span>
        <button
          className="primary"
          onClick={() => {
            projectActions.save();
            setRev(rev + 1);
          }}
          data-testid="project-save"
        >
          保存{operating ? '（運航状態を含む）' : ''}
        </button>
        <input placeholder="新しい名前" value={saveAsName} onChange={(e) => setSaveAsName(e.target.value)} data-testid="project-saveas-name" />
        <button
          onClick={() => {
            projectActions.saveAs(saveAsName || `${name}（コピー）`);
            setSaveAsName('');
            setRev(rev + 1);
          }}
          data-testid="project-saveas"
        >
          名前を付けて保存
        </button>
        <button onClick={download} data-testid="project-export">
          JSON に書き出し
        </button>
        <button onClick={() => fileRef.current?.click()} data-testid="project-import">
          JSON を読み込み
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          data-testid="project-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void f.text().then((t) => setReport(projectActions.importJson(t, f.name)));
          }}
        />
      </div>
      <div className="issues-list mgmt-grid">
        <section>
          <h4>保存したプロジェクト</h4>
          {slots.length === 0 ? (
            <div className="empty">まだ保存していません</div>
          ) : (
            <table className="board" data-testid="project-slots">
              <thead>
                <tr>
                  <th>名前</th>
                  <th>保存日時</th>
                  <th>機種データの版</th>
                  <th>運航状態</th>
                  <th>大きさ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {slots.map((x) => (
                  <tr key={x.id} className={x.id === projectId ? 'selected' : ''} data-testid={`project-slot-${x.name}`}>
                    <td>{x.name}</td>
                    <td>{x.savedAt ? new Date(x.savedAt).toLocaleString('ja-JP') : '—'}</td>
                    <td>{x.catalog}</td>
                    <td>{x.withSim ? 'あり' : '—'}</td>
                    <td className="num">{x.sizeKB} KB</td>
                    <td>
                      <button
                        onClick={() => {
                          if (!window.confirm(`「${x.name}」を開きますか？（開いている内容は、保存していなければ失われます）`)) return;
                          setReport(projectActions.load(x.id));
                          setRev(rev + 1);
                        }}
                        data-testid="project-load"
                      >
                        開く
                      </button>
                      <button
                        onClick={() => {
                          if (!window.confirm(`「${x.name}」を削除しますか？`)) return;
                          projectActions.remove(x.id);
                          setRev(rev + 1);
                        }}
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h4>版</h4>
          <div className="muted small" data-testid="project-versions">
            保存形式 v{PROJECT_FORMAT_VERSION} ／ 機種データ {pin ? `${pin.version}（保存時の値で固定）` : `${CATALOG_VERSION}（最新カタログ）`} ／ 3D アセット {ASSET_VERSION} ／
            シミュレーション {SIM_MODEL_VERSION}
          </div>
          {pin && (
            <div data-testid="catalog-pin">
              <h4>機種データ</h4>
              <div className="small">
                このプロジェクトは保存時の機種データ（版 {pin.version}・{Object.keys(pin.models).length} 機種）で動きます。
                {diff.length === 0 ? (
                  <span className="ok-text">最新カタログ（{CATALOG_VERSION}）と差分はありません。</span>
                ) : (
                  <span className="warn-text">最新カタログ（{CATALOG_VERSION}）と {diff.length} 件の差分があります。</span>
                )}
              </div>
              {diff.length > 0 && (
                <>
                  <button onClick={() => setShowDiff(!showDiff)} data-testid="catalog-diff-toggle">
                    {showDiff ? '差分を隠す' : '差分を確認'}
                  </button>
                  {showDiff && (
                    <>
                      <table className="board" data-testid="catalog-diff">
                        <thead>
                          <tr>
                            <th>機種</th>
                            <th>項目</th>
                            <th>保存時</th>
                            <th>最新</th>
                          </tr>
                        </thead>
                        <tbody>
                          {diff.map((d) => (
                            <tr key={`${d.id}.${d.field}`}>
                              <td>{d.id}</td>
                              <td>{d.field}</td>
                              <td className="small">{short(d.saved)}</td>
                              <td className="small">{short(d.current)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <button
                        className="primary"
                        disabled={operating}
                        onClick={() => window.confirm('最新カタログの機種データに切り替えますか？（座席数・性能などが上の差分のとおり変わります）') && projectActions.applyLatestCatalog()}
                        data-testid="catalog-apply-latest"
                      >
                        最新カタログを適用
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </section>
        <section>
          <h4>読み込みの検証結果</h4>
          {!report ? (
            <div className="empty">読み込むと、必須項目・型・ID の重複・参照切れ・不明な機種 ID・運航状態の整合を検証した結果がここに出ます</div>
          ) : (
            <div data-testid="project-report">
              <div className={report.ok ? 'ok-text' : 'ng-text'}>
                {report.ok ? '読み込みました' : '読み込めませんでした（開いているプロジェクトは変更していません）'}
                {report.migratedFrom ? `（${report.migratedFrom} から移行）` : ''}
              </div>
              {report.errors.length > 0 && (
                <ul className="plan-issues" data-testid="project-errors">
                  {report.errors.map((e, i) => (
                    <li key={i} className="ng-text">
                      {e}
                    </li>
                  ))}
                </ul>
              )}
              {report.warnings.length > 0 && (
                <ul className="plan-issues" data-testid="project-warnings">
                  {report.warnings.map((e, i) => (
                    <li key={i} className="warn-text">
                      {e}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="muted small">
            保存先はこのブラウザ（localStorage）です。別の端末へ移すには JSON に書き出してください。旧形式のレイアウトファイル（以前の「書き出し」）も読み込めます。
          </div>
        </section>
      </div>
    </div>
  );
}

/** テキストをファイルとして保存させる（URL はダウンロード開始後に解放する） */
export function downloadText(fileName: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function short(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object' && v && 'value' in v) return String((v as { value: unknown }).value ?? '未設定');
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}
