import { Link } from 'react-router-dom';
import type { NotificationSource } from './notifications.types';

// Chỉ tạo route nội bộ từ loại nguồn allowlist. API trang đích tiếp tục kiểm phiên/vai trò/chủ nguồn.
export function NotificationSourceLink({ source, role }: { source?: NotificationSource; role: string }) {
  if (!source || !/^[a-f0-9]{24}$/i.test(source.id)) return null;
  if (source.type === 'MEMBERSHIP' && role === 'MEMBER') return <Link to="/member/memberships">Xem gói tập hiện tại và lịch sử</Link>;
  if (source.type === 'PT_BOOKING' && (role === 'MEMBER' || role === 'TRAINER')) {
    return <Link to={role === 'MEMBER' ? '/member/pt-bookings' : '/trainer/bookings'}>Xem lịch PT hiện tại</Link>;
  }
  return null;
}
