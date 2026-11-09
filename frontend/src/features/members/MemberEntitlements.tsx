import type { EntitlementSummary, MembershipState, ReadTime } from './members.api';

export const membershipStateNames: Record<MembershipState, string> = {
  CURRENT: 'Đang hiệu lực', SCHEDULED: 'Chờ hiệu lực', EXPIRED: 'Đã hết hạn', NONE: 'Không có gói đã xác nhận',
};
export function MemberEntitlements({ summary }: { summary: EntitlementSummary }) {
  return <ul aria-label="Quyền lợi theo loại">{(['GYM', 'PT'] as const).map(kind =>
    <li key={kind}>{kind}: {summary[kind].map(state => membershipStateNames[state]).join(', ')}</li>)}</ul>;
}
export function MemberReadTime({ time }: { time: ReadTime }) {
  return <p>Đọc lúc {new Date(time.asOf).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}; ngày Việt Nam: {time.businessDate}.
    {' '}Dữ liệu có thể thay đổi giữa các lần tải; danh sách phân trang không dùng làm tổng báo cáo.</p>;
}
