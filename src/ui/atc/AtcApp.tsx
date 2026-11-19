import { useEffect, useRef, useState } from 'react';
import type { AirportLayout } from '../../core/model/types';
import {
  ATC_CLEARANCE_ROLE,
  buildAtcReport,
  buildCommunicationLog,
  candidateRunways,
  candidateStands,
  type AtcAssignmentRequest,
  type AtcRequest,
} from '../../core/atc/index';
import { ATC_SPEEDS, atcActions, atcStore, useAtc } from '../../atc/store';
import {
  ASSIGNMENT_KIND_LABEL,
  PHASE_LABEL,
  REQUEST_KIND_LABEL,
  ROLE_LABEL,
  aircraftCurrentWaitSec,
  aircraftList,
  arrivalSequenceEntries,
  canGoAround,
  canHold,
  canResume,
  formatAtcClock,
  formatDuration,
  openAssignmentsForAircraft,
  openQueueCounts,
  queueForRole,
} from '../../atc/viewModel';
import { RadarMap } from './RadarMap';
import './atc.css';

/**
 * ATC-08: 管制官モード専用画面。
 * 経営モードの EditorState / OpsState には一切触れず、ATC専用ストア
 * （src/atc/store.ts）と core/atc の公開関数だけで構成する。
 */

function downloadTextFile(fileName: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function AtcApp({
  currentLayout,
  onExit,
}: {
  currentLayout: AirportLayout;
  onExit: () => void;
}) {
  useAtc((s) => s.revision);
  const st = atcStore.getState();
  const { session, scenario, playing, speed } = st;

  // 再生ループ: 実時間 250ms ごとに速度分のゲーム秒を tick へ渡す
  const accRef = useRef(0);
  useEffect(() => {
    if (!playing) return;
    accRef.current = 0;
    const id = setInterval(() => {
      accRef.current += speed * 0.25;
      const whole = Math.floor(accRef.current);
      if (whole > 0) {
        accRef.current -= whole;
        atcActions.tick(whole);
      }
    }, 250);
    return () => clearInterval(id);
  }, [playing, speed]);

  // キーボード: Space=再生/停止、→=10秒ステップ、1-4=速度
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (!atcStore.getState().session) return;
      if (e.key === ' ') {
        atcActions.togglePlaying();
        e.preventDefault();
      } else if (e.key === 'ArrowRight') {
        atcActions.step(10);
        e.preventDefault();
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        atcActions.setSpeed(ATC_SPEEDS[Number(e.key) - 1]!);
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, []);

  useEffect(() => {
    void atcActions.refreshSummaries();
  }, []);

  return (
    <div className="atc-app">
      <header className="atc-top">
        <button onClick={onExit} data-testid="atc-exit">
          ← 経営モードへ戻る
        </button>
        <span className="atc-brand">✈ 管制官モード（ATC）</span>
        {scenario && session ? (
          <>
            <span className="atc-scenario">
              {scenario.name} ／ 空港: {scenario.airport.name}
            </span>
            <span className="atc-clock" data-testid="atc-clock">
              {formatAtcClock(session.clockSec)}
            </span>
            {session.finished && <span className="atc-finished">シナリオ終了</span>}
            <div className="atc-time-controls">
              <button
                className="primary"
                onClick={() => atcActions.togglePlaying()}
                disabled={session.finished}
                data-testid="atc-play"
                title="Space"
              >
                {playing ? '⏸ 一時停止' : '▶ 再生'}
              </button>
              {ATC_SPEEDS.map((v) => (
                <button
                  key={v}
                  className={speed === v ? 'active' : ''}
                  onClick={() => atcActions.setSpeed(v)}
                  data-testid={`atc-speed-${v}`}
                >
                  ×{v}
                </button>
              ))}
              <button onClick={() => atcActions.step(10)} disabled={playing} title="→">
                +10秒
              </button>
              <button onClick={() => atcActions.step(60)} disabled={playing}>
                +60秒
              </button>
            </div>
            <button
              onClick={() => {
                if (session.finished || window.confirm('現在のセッションを離れますか？（自動保存から再開できます）')) {
                  atcActions.exitToStart();
                }
              }}
              data-testid="atc-to-start"
            >
              シナリオ選択へ
            </button>
          </>
        ) : (
          <span className="atc-scenario">シナリオを選んで開始してください</span>
        )}
      </header>

      {st.notice && (
        <div className={`atc-notice ${st.notice.ok ? 'ok' : 'ng'}`} role="status">
          {st.notice.text}
        </div>
      )}
      {st.storageKind === 'memory' && (
        <div className="atc-notice ok">保存先: メモリ（IndexedDB が使えないため、このタブを閉じると保存データは消えます）</div>
      )}

      {!session || !scenario ? (
        <StartPanel currentLayout={currentLayout} />
      ) : (
        <>
          <div className="atc-main">
            <aside className="atc-col atc-queues">
              <QueuePanel role="ground" />
              <QueuePanel role="tower" />
              <SequencePanel />
            </aside>
            <section className="atc-col atc-center">
              <RadarMap
                airport={scenario.airport}
                session={session}
                selectedAircraftId={st.selectedAircraftId}
                onSelect={(id) => atcActions.selectAircraft(id)}
              />
              <AircraftList />
            </section>
            <aside className="atc-col atc-right">
              <DetailPanel />
              <ReportPanel />
              <SavePanel />
            </aside>
          </div>
          <footer className="atc-comm">
            <CommLog />
          </footer>
        </>
      )}
    </div>
  );
}

function StartPanel({ currentLayout }: { currentLayout: AirportLayout }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="atc-start">
      <h2>管制官モード</h2>
      <p>
        GROUND（地上管制）と TOWER（飛行場管制）を一人で担当し、自動生成される要求キューに対して
        割当の確定と許可の発行を行います。許可がない航空機は動きません。
        これはゲーム用の簡略モデルであり、現実の航空管制・安全基準への適合を主張するものではありません。
      </p>
      <div className="atc-start-actions">
        <button className="primary" onClick={() => atcActions.startTutorial()} data-testid="atc-start-tutorial">
          チュートリアルを開始（サンプル空港）
        </button>
        <button onClick={() => atcActions.startFromLayout(currentLayout)} data-testid="atc-start-layout">
          現在の経営レイアウトで開始（{currentLayout.name}）
        </button>
        <span className="atc-muted">
          経営レイアウトは一回限りのスナップショットとして複製され、経営側の状態は変更されません。
        </span>
      </div>
      <div className="atc-start-actions">
        <button onClick={() => fileRef.current?.click()} data-testid="atc-import">
          JSON を取り込む
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void f.text().then((text) => atcActions.importJson(text));
            e.target.value = '';
          }}
        />
      </div>
      <SavePanel startScreen />
    </div>
  );
}

function AssignmentRow({ assignment }: { assignment: AtcAssignmentRequest }) {
  const st = atcStore.getState();
  const { session, scenario } = st;
  const [target, setTarget] = useState<string>('');
  if (!session || !scenario || assignment.aircraftId === null) return null;
  const aircraft = session.aircraft[assignment.aircraftId];
  const candidates =
    assignment.kind === 'standAssignment'
      ? candidateStands(session, scenario.airport, assignment.aircraftId)
      : candidateRunways(session, scenario.airport, assignment.aircraftId);
  const value = target && candidates.includes(target) ? target : (candidates[0] ?? '');
  return (
    <div className="atc-queue-row" data-testid={`atc-assignment-${assignment.id}`}>
      <button className="atc-row-main" onClick={() => atcActions.selectAircraft(assignment.aircraftId)}>
        <b>{aircraft?.callsign ?? assignment.trafficEntryId}</b>
        <span>{ASSIGNMENT_KIND_LABEL[assignment.kind]}</span>
        {assignment.recommendedId && <span className="atc-muted">推奨: {assignment.recommendedId}</span>}
      </button>
      {candidates.length === 0 ? (
        <span className="atc-ng">候補がありません（条件に合う設備がありません）</span>
      ) : (
        <span className="atc-row-actions">
          <select value={value} onChange={(e) => setTarget(e.target.value)} aria-label="割当候補">
            {candidates.map((id, i) => (
              <option key={id} value={id}>
                {id}
                {i === 0 ? '（推奨）' : ''}
              </option>
            ))}
          </select>
          <button className="primary" onClick={() => atcActions.assign(assignment.id, value)}>
            確定
          </button>
        </span>
      )}
    </div>
  );
}

function RequestRow({ request }: { request: AtcRequest }) {
  const st = atcStore.getState();
  const { session } = st;
  if (!session) return null;
  const aircraft = session.aircraft[request.aircraftId];
  const wait = aircraft ? aircraftCurrentWaitSec(session, aircraft) : 0;
  const selected = st.selectedRequestId === request.id;
  return (
    <div className={`atc-queue-row${selected ? ' selected' : ''}`} data-testid={`atc-request-${request.id}`}>
      <button className="atc-row-main" onClick={() => atcActions.selectRequest(request.id)}>
        <b>{aircraft?.callsign ?? request.aircraftId}</b>
        <span>{REQUEST_KIND_LABEL[request.kind]}要求</span>
        <span className="atc-muted">待機 {formatDuration(wait)}</span>
      </button>
      <span className="atc-row-actions">
        {request.kind === 'runwayCrossing' ? (
          <button className="primary" onClick={() => atcActions.approveCrossing(request.id)}>
            横断を承認
          </button>
        ) : (
          <>
            <button className="primary" onClick={() => atcActions.issue(request.id)}>
              許可を発行
            </button>
            <button onClick={() => atcActions.reject(request.id)}>却下</button>
          </>
        )}
      </span>
    </div>
  );
}

function QueuePanel({ role }: { role: 'ground' | 'tower' }) {
  useAtc((s) => s.revision);
  const { session } = atcStore.getState();
  if (!session) return null;
  const queue = queueForRole(session, role);
  const scheduled = Object.values(session.assignments).filter(
    (a) => a.role === role && a.status === 'scheduled',
  ).length;
  return (
    <section className="atc-panel">
      <h3>
        {ROLE_LABEL[role]} キュー
        <span className="atc-badge">{queue.assignments.length + queue.requests.length}件</span>
      </h3>
      {queue.assignments.map((a) => (
        <AssignmentRow key={a.id} assignment={a} />
      ))}
      {queue.requests.map((r) => (
        <RequestRow key={r.id} request={r} />
      ))}
      {queue.assignments.length + queue.requests.length === 0 && (
        <p className="atc-muted">未処理の要求はありません</p>
      )}
      {scheduled > 0 && <p className="atc-muted">将来の割当要求: {scheduled}件（出現時にキューへ入ります）</p>}
    </section>
  );
}

function SequencePanel() {
  useAtc((s) => s.revision);
  const { session } = atcStore.getState();
  if (!session) return null;
  const entries = arrivalSequenceEntries(session);
  if (entries.length === 0) return null;
  const explicit = (session.arrivalSequence ?? []).length > 0;
  return (
    <section className="atc-panel">
      <h3>到着順序（TOWER）</h3>
      {!explicit && <p className="atc-muted">未指定のため推奨順（出現順）を表示しています。入れ替えると順序が設定され、着陸許可に効きます。</p>}
      <ol className="atc-sequence">
        {entries.map((a, i) => (
          <li key={a.id}>
            <span>
              {i + 1}. {a.callsign}（{PHASE_LABEL[a.phase]}）
            </span>
            <span className="atc-row-actions">
              <button onClick={() => atcActions.moveSequence(a.id, -1)} disabled={i === 0} aria-label="前へ">
                ↑
              </button>
              <button
                onClick={() => atcActions.moveSequence(a.id, 1)}
                disabled={i === entries.length - 1}
                aria-label="後へ"
              >
                ↓
              </button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function AircraftList() {
  useAtc((s) => s.revision);
  const st = atcStore.getState();
  const { session } = st;
  if (!session) return null;
  const list = aircraftList(session);
  return (
    <section className="atc-panel atc-aircraft-list">
      <h3>航空機一覧（{list.length}機）</h3>
      <table>
        <thead>
          <tr>
            <th>コールサイン</th>
            <th>機種</th>
            <th>種別</th>
            <th>段階</th>
            <th>待機</th>
            <th>累積待機</th>
          </tr>
        </thead>
        <tbody>
          {list.map((a) => (
            <tr
              key={a.id}
              className={st.selectedAircraftId === a.id ? 'selected' : ''}
              onClick={() => atcActions.selectAircraft(a.id)}
              data-testid={`atc-aircraft-${a.id}`}
            >
              <td>{a.callsign}</td>
              <td>{a.aircraftTypeId}</td>
              <td>{a.kind === 'arrival' ? '到着' : '出発'}</td>
              <td>
                {PHASE_LABEL[a.phase]}
                {a.movement?.held ? '（停止指示中）' : ''}
              </td>
              <td>{formatDuration(aircraftCurrentWaitSec(session, a))}</td>
              <td>{formatDuration(a.totalWaitSec)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length === 0 && <p className="atc-muted">まだ出現していません</p>}
    </section>
  );
}

function DetailPanel() {
  useAtc((s) => s.revision);
  const st = atcStore.getState();
  const { session, scenario } = st;
  if (!session || !scenario) return null;
  const aircraft = st.selectedAircraftId ? session.aircraft[st.selectedAircraftId] : undefined;
  if (!aircraft) {
    return (
      <section className="atc-panel">
        <h3>選択中の航空機</h3>
        <p className="atc-muted">マップまたは一覧から航空機を選んでください</p>
      </section>
    );
  }
  const activeRequest = aircraft.activeRequestId ? session.requests[aircraft.activeRequestId] : undefined;
  const activeClearance = aircraft.activeClearanceId
    ? session.clearances[aircraft.activeClearanceId]
    : undefined;
  const assignments = openAssignmentsForAircraft(session, aircraft.id);
  const counts = openQueueCounts(session);
  return (
    <section className="atc-panel" data-testid="atc-detail">
      <h3>
        {aircraft.callsign} <span className="atc-muted">（{aircraft.aircraftTypeId}）</span>
      </h3>
      <dl className="atc-detail-grid">
        <dt>種別</dt>
        <dd>{aircraft.kind === 'arrival' ? '到着' : '出発'}</dd>
        <dt>段階</dt>
        <dd>{PHASE_LABEL[aircraft.phase]}</dd>
        <dt>滑走路</dt>
        <dd>{aircraft.runwayId}</dd>
        <dt>スポット</dt>
        <dd>{aircraft.standId}</dd>
        <dt>待機</dt>
        <dd>
          現在 {formatDuration(aircraftCurrentWaitSec(session, aircraft))} ／ 累積{' '}
          {formatDuration(aircraft.totalWaitSec)}
        </dd>
        {aircraft.goAroundCount > 0 && (
          <>
            <dt>復行</dt>
            <dd>{aircraft.goAroundCount}回</dd>
          </>
        )}
      </dl>

      {assignments.map((a) => (
        <AssignmentRow key={a.id} assignment={a} />
      ))}

      {activeRequest && activeRequest.status === 'open' && (
        <div className="atc-detail-actions">
          <span>
            要求: {REQUEST_KIND_LABEL[activeRequest.kind]}（{ROLE_LABEL[ATC_CLEARANCE_ROLE[activeRequest.kind]]}）
          </span>
          {activeRequest.kind === 'runwayCrossing' ? (
            <button className="primary" onClick={() => atcActions.approveCrossing(activeRequest.id)}>
              横断を承認
            </button>
          ) : (
            <>
              <button className="primary" onClick={() => atcActions.issue(activeRequest.id)}>
                許可を発行
              </button>
              <button onClick={() => atcActions.reject(activeRequest.id)}>却下（待機）</button>
            </>
          )}
        </div>
      )}

      {activeClearance && (
        <div className="atc-detail-actions">
          <span>
            指示 {activeClearance.id}: {REQUEST_KIND_LABEL[activeClearance.kind]} ／ 状態{' '}
            {activeClearance.status}
            {activeClearance.status === 'issued' && '（復唱待ち。自動で進みます）'}
            {activeClearance.status === 'readback' && '（復唱済み。実行開始します）'}
            {activeClearance.status === 'executing' && '（実行中）'}
          </span>
          {(activeClearance.status === 'issued' || activeClearance.status === 'readback') && (
            <button onClick={() => atcActions.cancel(activeClearance.id)}>指示を取消</button>
          )}
        </div>
      )}

      <div className="atc-detail-actions">
        {canHold(session, aircraft.id) && (
          <button onClick={() => atcActions.hold(aircraft.id)}>停止指示</button>
        )}
        {canResume(session, aircraft.id) && (
          <button className="primary" onClick={() => atcActions.resume(aircraft.id)}>
            再開指示
          </button>
        )}
        {(aircraft.movement || activeRequest) && aircraft.completedAtSec === null && (
          <button onClick={() => atcActions.reroute(aircraft.id)}>経路変更（再計画）</button>
        )}
        {canGoAround(session, aircraft.id) && (
          <button onClick={() => atcActions.goAround(aircraft.id)}>復行（ゴーアラウンド）</button>
        )}
      </div>
      <p className="atc-muted">
        未処理キュー: GROUND {counts.ground}件 ／ TOWER {counts.tower}件
      </p>
    </section>
  );
}

function ReportPanel() {
  useAtc((s) => s.revision);
  const { session } = atcStore.getState();
  if (!session) return null;
  const report = buildAtcReport(session);
  return (
    <section className="atc-panel" data-testid="atc-report">
      <h3>評価レポート</h3>
      <dl className="atc-detail-grid">
        <dt>総合グレード</dt>
        <dd>
          {report.overall.grade}（処理スコア {report.overall.throughputScore}
          {report.overall.cappedBySafety ? '・安全評価により上限適用' : ''}）
        </dd>
        <dt>安全評価</dt>
        <dd>
          {report.safety.rating === 'clean'
            ? 'クリーン'
            : report.safety.rating === 'events'
              ? '安全関連イベントあり'
              : '安全拒否あり'}
          （拒否 {report.safety.safetyDenials}件 ／ 期限切れ {report.safety.clearancesExpired}件 ／ 取消{' '}
          {report.safety.clearancesCancelled}件 ／ 復行 {report.safety.goArounds}件）
        </dd>
        <dt>処理</dt>
        <dd>
          到着 {report.throughput.arrivalsHandled} ／ 出発 {report.throughput.departuresHandled} ／ 出現{' '}
          {report.throughput.aircraftSpawned}機（処理率 {Math.round(report.throughput.completionRatio * 100)}%）
        </dd>
        <dt>待機</dt>
        <dd>
          累積 {formatDuration(report.throughput.totalWaitSec)} ／ 処理済み平均{' '}
          {formatDuration(report.throughput.avgWaitSecPerHandled)}
        </dd>
        <dt>応答時間</dt>
        <dd>
          平均 {formatDuration(report.throughput.response.avgSec)} ／ 最大{' '}
          {formatDuration(report.throughput.response.maxSec)}（{report.throughput.response.count}件）
        </dd>
        <dt>管制負荷</dt>
        <dd>指示発行 {report.throughput.clearancesIssued}件 ／ ピーク {report.throughput.peakHourlyClearances}件/時</dd>
      </dl>
    </section>
  );
}

function SavePanel({ startScreen = false }: { startScreen?: boolean }) {
  useAtc((s) => s.revision);
  const st = atcStore.getState();
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <section className="atc-panel">
      <h3>保存データ（ATC専用）</h3>
      {!startScreen && (
        <div className="atc-row-actions">
          <button className="primary" onClick={() => void atcActions.saveManual()} data-testid="atc-save">
            現在のセッションを保存
          </button>
          <button
            onClick={() => {
              const json = atcActions.exportJson();
              if (json) downloadTextFile(`skyport-atc-${st.scenario?.id ?? 'session'}.json`, json);
            }}
            data-testid="atc-export"
          >
            JSON 書き出し
          </button>
          <button onClick={() => fileRef.current?.click()}>JSON 取り込み</button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then((text) => atcActions.importJson(text));
              e.target.value = '';
            }}
          />
        </div>
      )}
      {st.lastAutosaveIso && (
        <p className="atc-muted">最終自動保存: {new Date(st.lastAutosaveIso).toLocaleTimeString('ja-JP')}</p>
      )}
      {st.summaries.length === 0 ? (
        <p className="atc-muted">保存データはありません</p>
      ) : (
        <ul className="atc-saves">
          {st.summaries.map((s) => (
            <li key={s.id}>
              <span>
                {s.kind === 'autosave' ? '自動保存' : '手動保存'}: {s.scenarioName} ／{' '}
                {formatAtcClock(s.clockSec)} ／ {new Date(s.savedAtIso).toLocaleString('ja-JP')}
                {s.finished ? '（終了）' : ''}
              </span>
              <span className="atc-row-actions">
                <button onClick={() => void atcActions.loadSaved(s.id)}>再開</button>
                <button
                  onClick={() => {
                    if (window.confirm('この保存データを削除しますか？')) void atcActions.removeSaved(s.id);
                  }}
                >
                  削除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CommLog() {
  useAtc((s) => s.revision);
  const st = atcStore.getState();
  const { session } = st;
  if (!session) return null;
  const log = buildCommunicationLog(session).slice(-150).reverse();
  return (
    <>
      <h3>通信ログ</h3>
      <div className="atc-comm-list">
        {log.map((e) => (
          <div key={e.id} className={`atc-comm-row ${e.speaker}`}>
            <span className="atc-comm-time">{formatAtcClock(e.atSec)}</span>
            <span className="atc-comm-role">
              {e.speaker === 'controller' ? (e.role === 'tower' ? 'TOWER' : 'GROUND') : 'PILOT'}
            </span>
            <button className="atc-comm-text" onClick={() => e.aircraftId && atcActions.selectAircraft(e.aircraftId)}>
              {e.text}
            </button>
          </div>
        ))}
        {log.length === 0 && <p className="atc-muted">通信はまだありません</p>}
      </div>
    </>
  );
}
