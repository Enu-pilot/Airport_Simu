import { useMemo } from 'react';
import { useEditor, useLayout } from '../../editor/store';
import { ops } from '../../editor/simRunner';
import { reviewUi } from './reviewUi';
import { useCompany } from '../ManagementPanels';
import { createContext } from '../../core/sim/context';
import { analyzeAccess } from '../../core/access/model';
import { planDayWithDemand } from '../../core/economy/planning';
import { routeCapabilitiesForAirport } from '../../core/economy/registry';
import { useSecondly } from '../operate/Card';
import { SHELL_UI } from '../../i18n/ja';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** 発着波形: 計画便の到着・出発を時間帯ごとの回数に集計する（表示のみの純関数） */
export function hourlyMovements(flights: readonly { arrivalAt: number; departureAt: number }[]): number[] {
  const counts = new Array<number>(24).fill(0);
  for (const f of flights) {
    const ah = Math.min(23, Math.max(0, Math.floor(f.arrivalAt / 3600)));
    const dh = Math.min(23, Math.max(0, Math.floor(f.departureAt / 3600)));
    counts[ah] = (counts[ah] ?? 0) + 1;
    counts[dh] = (counts[dh] ?? 0) + 1;
  }
  return counts;
}

/**
 * UIデザイン更新 第1段階: 下部24時間タイムライン（表示のみ）。
 * その日の計画の発着波形（到着+出発の回数/時）と、運航中は現在時刻マーカーを出す。
 * 計画の作り方は運航計画パネル（PlanPanel）と同じ式。
 * 第5段階: 最も高い時間帯にピークマーカーを付け、振り返りがある日は時間帯クリックで
 * 日報ドロワーの該当行（その時間帯がピークの工程）へジャンプできる（表示の誘導のみ）。
 */
export function Timeline() {
  const layout = useLayout();
  const company = useCompany();
  const wave = useMemo(() => {
    const ctx = createContext(layout);
    const accessFactor = analyzeAccess(layout, { fees: company.fees, feedback: company.accessFeedback, city: company.city, day: company.day }).factor;
    const plan = planDayWithDemand(company, company.day, accessFactor, ctx.types, routeCapabilitiesForAirport(layout.countryId));
    return hourlyMovements(plan.flights);
  }, [layout, company]);
  const now = useSecondly((o) => o.sim.state.now);
  const hasReview = useEditor((s) => s.dayFlow.review !== null);
  const max = Math.max(1, ...wave);
  const peak = Math.max(0, ...wave);
  const nowInDay = now === null ? null : ((now % 86400) + 86400) % 86400;
  return (
    <footer className="shell-timeline" data-testid="shell-timeline">
      <div className="timeline-head">
        <strong>{SHELL_UI.timelineTitle}</strong>
        <span className="muted small">{SHELL_UI.timelinePlanNote}</span>
        {nowInDay !== null && (
          <span className="small" data-testid="timeline-now-label">
            {SHELL_UI.timelineNow(Math.floor(nowInDay / 3600), Math.floor((nowInDay % 3600) / 60))}
          </span>
        )}
      </div>
      <div className="timeline-wave" role="img" aria-label={SHELL_UI.timelinePlanNote}>
        {HOURS.map((h) => (
          <div
            key={h}
            className={`timeline-bar${peak > 0 && wave[h] === peak ? ' peak' : ''}${hasReview ? ' clickable' : ''}`}
            style={{ height: `${Math.round((wave[h]! / max) * 100)}%` }}
            title={`${h}:00 ${SHELL_UI.timelineFlights(wave[h]!)}`}
            data-testid={`timeline-hour-${h}`}
            onClick={
              hasReview
                ? () => {
                    // 第5段階: 時間帯から日報ドロワーの該当行（工程ピーク）へジャンプする
                    reviewUi.requestFocusHour(h);
                    ops.openReview();
                  }
                : undefined
            }
          />
        ))}
        {nowInDay !== null && <div className="timeline-now" style={{ left: `${(nowInDay / 86400) * 100}%` }} data-testid="timeline-now" />}
        <div className="timeline-ticks" aria-hidden>
          {[0, 6, 12, 18, 24].map((h) => (
            <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{h}:00</span>
          ))}
        </div>
      </div>
    </footer>
  );
}
