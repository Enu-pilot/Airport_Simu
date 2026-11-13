import { OPS_UI, UNIT_KIND_LABEL } from '../../../i18n/ja';
import type { UnitKind } from '../../../core/sim/types';
import { useOps } from '../../OpsPanels';
import { Card, CardRow } from '../Card';

/** 地上支援（作業員・車両の稼働と故障）と手荷物（処理中・積み残し・設備の停止） */
export function GroundCard() {
  const o = useOps();
  if (!o) return null;
  const { state, ctx } = o.sim;
  const units = Object.values(state.units);
  const kinds = [...new Set(units.map((u) => u.kind))] as UnitKind[];
  const broken = units.filter((u) => u.status === 'broken').length;
  const gs = state.groundStats;
  const eqDown = Object.values(state.equipment).filter((e) => e.broken).length;
  const blocked = state.activeTasks.map((id) => state.tasks[id]!).filter((t) => t.blockedReason && t.blockedReason !== 'dependency' && t.blockedReason !== 'waitingTime').length;
  return (
    <Card id="ground" title={OPS_UI.groundTitle} open="ground" badge={broken > 0 ? OPS_UI.brokenBadge(broken) : undefined}>
      {kinds.map((k) => {
        const list = units.filter((u) => u.kind === k);
        const working = list.filter((u) => u.status === 'working').length;
        const bad = list.filter((u) => u.status === 'broken').length;
        return (
          <CardRow key={k} label={UNIT_KIND_LABEL[k]} tone={bad > 0 ? 'bad' : undefined} testid={`card-units-${k}`}>
            {OPS_UI.unitText(working, list.length, bad)}
          </CardRow>
        );
      })}
      <CardRow label={OPS_UI.blockedTasks} tone={blocked > 0 ? 'warn' : undefined}>
        {blocked}
      </CardRow>
      <CardRow label={OPS_UI.bagsActive}>{state.activeBags.length}</CardRow>
      <CardRow label={OPS_UI.bagsLeft} tone={gs.bagsLeftBehind > 0 ? 'bad' : undefined}>
        {gs.bagsLeftBehind}
      </CardRow>
      <CardRow label={OPS_UI.equipment} tone={eqDown > 0 ? 'bad' : undefined}>
        {eqDown > 0 ? OPS_UI.equipmentDown(eqDown) : OPS_UI.equipmentOk(ctx.sorters.length)}
      </CardRow>
    </Card>
  );
}
