import { Icon } from '../../components/Icon';
import type { EntitlementSummary, MembershipState, ReadTime, ServiceKind } from './members.api';

export const membershipStateNames: Record<MembershipState, string> = {
  CURRENT: 'Đang hiệu lực', SCHEDULED: 'Chờ hiệu lực', EXPIRED: 'Đã hết hạn', NONE: 'Không có gói đã xác nhận',
};
export function EntitlementChips({ kind, states }: { kind: ServiceKind; states: MembershipState[] }) {
  return <span className="gm-entitlement-chips">{states.map(state =>
    <span className="gm-chip" key={state} data-state={state}>{kind}: {membershipStateNames[state]}</span>)}</span>;
}
export function MemberEntitlements({ summary }: { summary: EntitlementSummary }) {
  return <ul className="gm-entitlement-list" aria-label="Quyền lợi theo loại">{(['GYM', 'PT'] as const).map(kind =>
    <li key={kind}><span className="gm-icon-tile"><Icon name={kind === 'GYM' ? 'weights' : 'users'} /></span>
      <div><strong>{kind}</strong><p>{kind === 'GYM' ? 'Quyền sử dụng phòng tập' : 'Buổi tập với huấn luyện viên'}</p></div>
      <EntitlementChips kind={kind} states={summary[kind]} /></li>)}</ul>;
}
export function MemberReadTime({ time }: { time: ReadTime }) {
  return <p className="gm-read-time">Đọc lúc {new Date(time.asOf).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} · ngày Việt Nam: {time.businessDate}.</p>;
}
