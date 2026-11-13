import { compareIds } from '../../../core/model/ids';
import { designatorsOf } from '../../../core/layout/designators';
import { RUNWAY_UI } from '../../../i18n/ja';
import { RunwayRow, useOps } from '../../OpsPanels';
import { Card } from '../Card';

/** 滑走路の状態と運用（方向・モード）。行は従来の RunwayRow をそのまま使う */
export function RunwayCard() {
  const o = useOps();
  if (!o) return null;
  const { state, ctx } = o.sim;
  return (
    <Card id="runway" title="滑走路">
      {Object.keys(state.runways)
        .sort(compareIds)
        .map((rid) => (
          <RunwayRow key={rid} state={state} rid={rid} layoutRunway={ctx.layout.runways[rid]!} layout={ctx.layout} />
        ))}
      {ctx.crossings.map((x) => (
        <div key={x.id} className="runway-row" data-testid={`crossing-${x.id}`}>
          <div className="runway-name">
            {RUNWAY_UI.crossingTitle}: {designatorsOf(ctx.layout.runways[x.a]!, ctx.layout).text.join('/')} × {designatorsOf(ctx.layout.runways[x.b]!, ctx.layout).text.join('/')}
          </div>
          <div className="runway-q">{RUNWAY_UI.crossingDependent}</div>
        </div>
      ))}
    </Card>
  );
}
