import { readbackTextFor } from './commands';
import type {
  AtcControlRole,
  AtcEvent,
  AtcRequestKind,
  AtcSessionState,
} from './types';
import { ATC_CLEARANCE_ROLE } from './types';

/**
 * ATC-09: 定型通信ログ。
 * セッションのイベント列と要求/指示レコードから決定的に導出する読み取り専用
 * ログであり、新しい状態は持たない。イベント列は保存対象なので、保存→復元
 * 後も同じログが得られ、同じ seed・指示列では同じログになる（計画 §5 受入）。
 *
 * 文面は既存の定型復唱文（commands.readbackTextFor）の流儀に合わせ、
 * コールサイン・指示種別・滑走路/スポットを含む定型文とする。
 * 通信に当たらない内部イベント（出現・段階変化・割当の内部記録・順序変更）は
 * ログに含めない。割当の確定（スポット/滑走路）はパイロットへ通知されるため
 * 管制官の発話として含める。
 */

export type AtcCommSpeaker = 'controller' | 'pilot';

export type AtcCommCategory =
  | 'request' // パイロットからの要求
  | 'assignment' // 管制官からの割当通知
  | 'clearance' // 管制官の許可・指示
  | 'readback' // パイロットの復唱
  | 'readbackMismatch' // 復唱不一致の指摘
  | 'denial' // 安全判定による拒否の通知
  | 'rejection' // 要求却下（待機指示）
  | 'warning' // 安全警告
  | 'revocation' // 実行直前の失効通知
  | 'execution' // パイロットの実行開始報告
  | 'completion' // パイロットの完了報告
  | 'cancel' // 指示取消の通知
  | 'expire' // 指示失効の通知
  | 'hold' // 停止指示
  | 'resume' // 再開指示
  | 'reroute' // 経路変更指示
  | 'goAround'; // 復行（パイロット通報＋管制官の了承）

export interface AtcCommunicationEntry {
  /** 決定的ID（元イベントIDから導出） */
  id: string;
  atSec: number;
  speaker: AtcCommSpeaker;
  /** 管制側の担当区分（GROUND/TOWER）。発話・宛先の区分 */
  role?: AtcControlRole;
  callsign: string;
  aircraftId?: string;
  clearanceId?: string;
  /** 導出元のイベントID */
  eventId: string;
  category: AtcCommCategory;
  text: string;
}

/** パイロットの要求文（指示種別ごとに定型化） */
function pilotRequestText(
  callsign: string,
  kind: AtcRequestKind,
  ctx: { runwayId?: string; standId?: string },
): string {
  switch (kind) {
    case 'pushback':
      return `${callsign}, request pushback.`;
    case 'taxiOut':
      return `${callsign}, request taxi to runway ${ctx.runwayId ?? ''}.`;
    case 'taxiIn':
      return `${callsign}, request taxi to stand ${ctx.standId ?? ''}.`;
    case 'runwayCrossing':
      return `${callsign}, request crossing runway ${ctx.runwayId ?? ''}.`;
    case 'lineUp':
      return `${callsign}, request line up runway ${ctx.runwayId ?? ''}.`;
    case 'takeoff':
      return `${callsign}, request takeoff runway ${ctx.runwayId ?? ''}.`;
    case 'landing':
      return `${callsign}, request landing runway ${ctx.runwayId ?? ''}.`;
  }
}

/**
 * イベント列から定型通信ログを導出する。
 * イベントは発生順（＝保存順）に処理し、要求レコードの突合もその順序で
 * 行うため、結果は決定的である。
 */
export function buildCommunicationLog(session: AtcSessionState): AtcCommunicationEntry[] {
  const log: AtcCommunicationEntry[] = [];
  const usedRequestIds = new Set<string>();

  const callsignOf = (event: AtcEvent): string => {
    if (event.aircraftId && session.aircraft[event.aircraftId]) {
      return session.aircraft[event.aircraftId]!.callsign;
    }
    const m = /^([^:]+):/.exec(event.message);
    return m ? m[1]! : '';
  };

  const push = (
    event: AtcEvent,
    entry: Omit<AtcCommunicationEntry, 'id' | 'atSec' | 'eventId' | 'callsign'> & {
      callsign?: string;
      suffix?: string;
    },
  ): void => {
    const { suffix, callsign, ...rest } = entry;
    log.push({
      id: `com_${event.id}${suffix ?? ''}`,
      atSec: event.atSec,
      eventId: event.id,
      callsign: callsign ?? callsignOf(event),
      ...rest,
    });
  };

  for (const event of session.events) {
    const aircraft = event.aircraftId ? session.aircraft[event.aircraftId] : undefined;
    const clearance = event.clearanceId ? session.clearances[event.clearanceId] : undefined;
    switch (event.kind) {
      case 'request': {
        const msg = event.message;
        if (msg.startsWith('asg_')) break; // 割当要求の内部記録（通信ではない）
        let m = /: stand assigned (\S+) \(ground\)/.exec(msg);
        if (m) {
          push(event, {
            speaker: 'controller',
            role: 'ground',
            category: 'assignment',
            aircraftId: event.aircraftId,
            text: `${callsignOf(event)}, stand ${m[1]} assigned.`,
          });
          break;
        }
        m = /: runway assigned (\S+) \(tower\)/.exec(msg);
        if (m) {
          push(event, {
            speaker: 'controller',
            role: 'tower',
            category: 'assignment',
            aircraftId: event.aircraftId,
            text: `${callsignOf(event)}, runway ${m[1]} assigned.`,
          });
          break;
        }
        m = /: request runwayCrossing (\S+) at /.exec(msg);
        if (m) {
          push(event, {
            speaker: 'pilot',
            role: 'ground',
            category: 'request',
            aircraftId: event.aircraftId,
            text: pilotRequestText(callsignOf(event), 'runwayCrossing', { runwayId: m[1] }),
          });
          break;
        }
        if (msg.includes('assignment reopened')) break; // 割当再オープンは内部記録
        // 通常の要求: 同時刻・同機の未使用の要求レコードと突合する
        const request = Object.values(session.requests)
          .filter(
            (r) =>
              r.aircraftId === event.aircraftId &&
              r.createdAtSec === event.atSec &&
              r.kind !== 'runwayCrossing' &&
              !usedRequestIds.has(r.id),
          )
          .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
        if (!request || !aircraft) break;
        usedRequestIds.add(request.id);
        push(event, {
          speaker: 'pilot',
          role: ATC_CLEARANCE_ROLE[request.kind],
          category: 'request',
          aircraftId: event.aircraftId,
          text: pilotRequestText(aircraft.callsign, request.kind, {
            runwayId: aircraft.runwayId,
            standId: aircraft.standId,
          }),
        });
        break;
      }
      case 'clearanceIssued': {
        if (clearance && aircraft) {
          push(event, {
            speaker: 'controller',
            role: ATC_CLEARANCE_ROLE[clearance.kind],
            category: 'clearance',
            aircraftId: event.aircraftId,
            clearanceId: clearance.id,
            text: readbackTextFor(clearance, aircraft.callsign),
          });
          break;
        }
        // 滑走路横断の承認（指示レコードを持たないゲート承認）
        const m = /: cleared runwayCrossing (\S+) at /.exec(event.message);
        if (m) {
          push(event, {
            speaker: 'controller',
            role: 'ground',
            category: 'clearance',
            aircraftId: event.aircraftId,
            text: `${callsignOf(event)}, cleared to cross runway ${m[1]}.`,
          });
        }
        break;
      }
      case 'clearanceRejected': {
        // 安全拒否の通知。理由コードはイベント文（自形式）から取り出す
        const cross = /: runwayCrossing (\S+) denied \(([^)]*)\)/.exec(event.message);
        if (cross) {
          push(event, {
            speaker: 'controller',
            role: 'ground',
            category: 'denial',
            aircraftId: event.aircraftId,
            text: `${callsignOf(event)}, crossing runway ${cross[1]} denied: ${cross[2]}.`,
          });
          break;
        }
        const m = /: (\S+) denied \(([^)]*)\)/.exec(event.message);
        if (m) {
          const kind = m[1] as AtcRequestKind;
          push(event, {
            speaker: 'controller',
            role: ATC_CLEARANCE_ROLE[kind] ?? undefined,
            category: 'denial',
            aircraftId: event.aircraftId,
            text: `${callsignOf(event)}, ${kind} clearance denied: ${m[2]}.`,
          });
        }
        break;
      }
      case 'readback': {
        if (event.message.endsWith('readback mismatch')) {
          push(event, {
            speaker: 'controller',
            role: clearance ? ATC_CLEARANCE_ROLE[clearance.kind] : undefined,
            category: 'readbackMismatch',
            aircraftId: event.aircraftId,
            clearanceId: event.clearanceId,
            text: `${callsignOf(event)}, readback incorrect, say again.`,
          });
          break;
        }
        push(event, {
          speaker: 'pilot',
          role: clearance ? ATC_CLEARANCE_ROLE[clearance.kind] : undefined,
          category: 'readback',
          aircraftId: event.aircraftId,
          clearanceId: event.clearanceId,
          // 復唱文は記録されたものをそのまま使う（無ければ定型文を生成）
          text: clearance?.readbackText ?? event.message,
        });
        break;
      }
      case 'executionStarted': {
        if (!clearance) break;
        push(event, {
          speaker: 'pilot',
          role: ATC_CLEARANCE_ROLE[clearance.kind],
          category: 'execution',
          aircraftId: event.aircraftId,
          clearanceId: clearance.id,
          text: `${callsignOf(event)}, executing ${clearance.kind}.`,
        });
        break;
      }
      case 'clearanceCompleted': {
        if (!clearance) break;
        push(event, {
          speaker: 'pilot',
          role: ATC_CLEARANCE_ROLE[clearance.kind],
          category: 'completion',
          aircraftId: event.aircraftId,
          clearanceId: clearance.id,
          text: `${callsignOf(event)}, ${clearance.kind} completed.`,
        });
        break;
      }
      case 'clearanceCancelled': {
        push(event, {
          speaker: 'controller',
          role: clearance ? ATC_CLEARANCE_ROLE[clearance.kind] : undefined,
          category: 'cancel',
          aircraftId: event.aircraftId,
          clearanceId: event.clearanceId,
          text: clearance
            ? `${callsignOf(event)}, ${clearance.kind} clearance cancelled, hold position.`
            : `${callsignOf(event)}, clearance cancelled, hold position.`,
        });
        break;
      }
      case 'clearanceExpired': {
        push(event, {
          speaker: 'controller',
          role: clearance ? ATC_CLEARANCE_ROLE[clearance.kind] : undefined,
          category: 'expire',
          aircraftId: event.aircraftId,
          clearanceId: event.clearanceId,
          text: clearance
            ? `${callsignOf(event)}, ${clearance.kind} clearance expired, hold position.`
            : `${callsignOf(event)}, clearance expired, hold position.`,
        });
        break;
      }
      case 'safetyWarning': {
        const reasons = /\(([^)]*)\)\s*$/.exec(event.message)?.[1] ?? '';
        if (event.message.includes('revoked before execution')) {
          push(event, {
            speaker: 'controller',
            role: clearance ? ATC_CLEARANCE_ROLE[clearance.kind] : undefined,
            category: 'revocation',
            aircraftId: event.aircraftId,
            clearanceId: event.clearanceId,
            text: `${callsignOf(event)}, clearance revoked before execution: ${reasons}.`,
          });
          break;
        }
        push(event, {
          speaker: 'controller',
          role: clearance ? ATC_CLEARANCE_ROLE[clearance.kind] : undefined,
          category: 'warning',
          aircraftId: event.aircraftId,
          clearanceId: event.clearanceId,
          text: `${callsignOf(event)}, caution: ${reasons}.`,
        });
        break;
      }
      case 'requestRejected': {
        const cross = /: runwayCrossing (\S+) request cancelled by reroute/.exec(event.message);
        if (cross) {
          push(event, {
            speaker: 'controller',
            role: 'ground',
            category: 'rejection',
            aircraftId: event.aircraftId,
            text: `${callsignOf(event)}, crossing request for runway ${cross[1]} cancelled.`,
          });
          break;
        }
        const m = /: (\S+) request rejected, hold/.exec(event.message);
        if (m) {
          const kind = m[1] as AtcRequestKind;
          push(event, {
            speaker: 'controller',
            role: ATC_CLEARANCE_ROLE[kind] ?? undefined,
            category: 'rejection',
            aircraftId: event.aircraftId,
            text: `${callsignOf(event)}, ${kind} request denied, hold position.`,
          });
        }
        break;
      }
      case 'holdStarted': {
        push(event, {
          speaker: 'controller',
          role: 'ground',
          category: 'hold',
          aircraftId: event.aircraftId,
          text: `${callsignOf(event)}, hold position.`,
        });
        break;
      }
      case 'holdReleased': {
        const m = /: resume (\S+)/.exec(event.message);
        push(event, {
          speaker: 'controller',
          role: 'ground',
          category: 'resume',
          aircraftId: event.aircraftId,
          text: m ? `${callsignOf(event)}, resume ${m[1]}.` : `${callsignOf(event)}, resume taxi.`,
        });
        break;
      }
      case 'rerouted': {
        const m = /: (?:rerouted|route planned for) (\S+)/.exec(event.message);
        push(event, {
          speaker: 'controller',
          role: 'ground',
          category: 'reroute',
          aircraftId: event.aircraftId,
          text: m
            ? `${callsignOf(event)}, rerouted for ${m[1]}.`
            : `${callsignOf(event)}, route changed.`,
        });
        break;
      }
      case 'goAround': {
        push(event, {
          speaker: 'pilot',
          role: 'tower',
          category: 'goAround',
          aircraftId: event.aircraftId,
          clearanceId: event.clearanceId,
          suffix: '_a',
          text: `${callsignOf(event)}, going around runway ${aircraft?.runwayId ?? ''}.`,
        });
        push(event, {
          speaker: 'controller',
          role: 'tower',
          category: 'goAround',
          aircraftId: event.aircraftId,
          clearanceId: event.clearanceId,
          suffix: '_b',
          text: `${callsignOf(event)}, roger, go around.`,
        });
        break;
      }
      default:
        // spawn / phaseChanged / sequenceChanged / completed は通信ではない
        break;
    }
  }
  return log;
}

/** 通信ログの決定性比較用ダイジェスト（テスト・保存復元確認用） */
export function communicationLogDigest(log: AtcCommunicationEntry[]): string {
  const canonical = JSON.stringify(
    log.map((e) => [e.id, e.atSec, e.speaker, e.role ?? '', e.callsign, e.category, e.text]),
  );
  let h = 2166136261;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
