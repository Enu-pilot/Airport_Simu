import { useEffect } from 'react';
import { Viewport } from '../../render/MapView';
import { OpsControls } from '../OpsPanels';
import { StatusBar, Toast } from '../StatusBar';
import { AirlineCard } from './cards/AirlineCard';
import { AccessCard } from './cards/AccessCard';
import { ConstructionCard } from './cards/ConstructionCard';
import { EventsCard } from './cards/EventsCard';
import { GoalsCard } from './cards/GoalsCard';
import { GroundCard } from './cards/GroundCard';
import { RunwayCard } from './cards/RunwayCard';
import { TerminalCard } from './cards/TerminalCard';
import { TodayKpiCard } from './cards/TodayKpiCard';
import { WeatherCard } from './cards/WeatherCard';
import { AlertStack } from './AlertStack';
import { DetailOverlay } from './DetailOverlay';
import { FidsOverlay } from './FidsOverlay';
import { OpsDetail } from './OpsDetail';
import { opsUi } from './opsUi';
import './operate.css';

/**
 * 運航モードの画面（docs/06_ui_design.md）: 左右に常設のカード、中央にマップと右上の運航表、
 * 下に選択中の詳細。あまり使わないパネルは大きなオーバーレイで開く。
 */
export function OperateLayout() {
  // 運航モードを離れたら表示の状態（オーバーレイ・運航表の設定）を初期化する
  useEffect(() => () => opsUi.reset(), []);
  return (
    <>
      <aside className="left ops-left" data-testid="ops-left">
        <OpsControls />
        <TodayKpiCard />
        <RunwayCard />
        <WeatherCard />
        <ConstructionCard />
        <GoalsCard />
      </aside>
      <main className="center ops-center">
        <Viewport />
        <FidsOverlay />
        <AlertStack />
        <StatusBar />
        <Toast />
      </main>
      <aside className="right ops-right" data-testid="ops-right">
        <TerminalCard />
        <GroundCard />
        <AccessCard />
        <AirlineCard />
        <EventsCard />
      </aside>
      <OpsDetail />
      <DetailOverlay />
    </>
  );
}
