import { MembershipState } from './members-query.dto';

// US-11-F03: ngày lịch YYYY-MM-DD, hai biên CURRENT đều được tính. Không ghi lại status.
export function membershipTimeState(status: string, transactionStatus: string, startDate: string,
  endDate: string, today: string): MembershipState {
  if (status !== 'ACTIVE' || transactionStatus !== 'SETTLED') return 'NONE';
  if (startDate > today) return 'SCHEDULED';
  return endDate < today ? 'EXPIRED' : 'CURRENT';
}
