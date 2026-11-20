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
import { FidsOverlay } from './FidsOverlay';
import { OpsDetail } from './OpsDetail';
import { opsUi } from './opsUi';
import './operate.css';

/**
 * 運航レンズの画面（UIデザイン更新 第4段階）: 左パネルに運航コントロールと常設カード、
 * 中央にマップと運航表・アラート、右列の先頭に選択中の詳細（右インスペクタ）、残りに常設カード。
 * 大きなパネル群は運航ボード（OpsBoard、App 側でボードモード表示）で開く。
 * 運航表（FIDS）は併用（ユーザ決定C）: 浮動パネルは要約表示のみ、全列表示は運航ボード。
 * ライブアラートも決定C: マップ左上のスタックは重大のみ、注意は要対応インボックスのみに出す。
 */
export function OperateLayout() {
  // 運航モードを離れたら表示の状態（ボード・運航表の設定）を初期化する
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
        <OpsDetail />
        <TerminalCard />
        <GroundCard />
        <AccessCard />
        <AirlineCard />
        <EventsCard />
      </aside>
    </>
  );
}
