import { addCalendarDays } from '../../common/utils/business-date';

export type ReminderSource = 'MEMBERSHIP' | 'PT_BOOKING';
export type ReminderMilestone = '3D' | '1D' | '24H' | '2H';
export interface ReminderWindow { dueAt: Date; until: Date }
export type ReminderStatus = 'STORED' | 'SKIPPED_STALE' | 'SKIPPED_INELIGIBLE';

export function vietnamMidnight(day: string): Date { return new Date(`${day}T00:00:00+07:00`); }
export function vietnamDay(now: Date): string { return new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10); }

export function membershipWindow(endDate: string, milestone: '3D' | '1D'): ReminderWindow {
  return { dueAt: vietnamMidnight(addCalendarDays(endDate, milestone === '3D' ? -3 : -1)),
    until: vietnamMidnight(addCalendarDays(endDate, milestone === '3D' ? -1 : 1)) };
}

export function bookingWindow(startAt: Date, milestone: '24H' | '2H'): ReminderWindow {
  return { dueAt: new Date(startAt.getTime() - (milestone === '24H' ? 24 : 2) * 3600000),
    until: new Date(startAt.getTime() - (milestone === '24H' ? 2 : 0) * 3600000) };
}

// Chưa đến mốc thì không được lưu quyết định terminal, kể cả nguồn đang ineligible.
export function reminderDecision(now: Date, window: ReminderWindow, ineligible?: string):
  { status: ReminderStatus; reason?: string } | null {
  if (now < window.dueAt) return null;
  if (now >= window.until) return { status: 'SKIPPED_STALE', reason: 'WINDOW_CLOSED' };
  return ineligible ? { status: 'SKIPPED_INELIGIBLE', reason: ineligible } : { status: 'STORED' };
}

export function existedAt(createdAt: Date | undefined, dueAt: Date): boolean {
  // Dữ liệu cũ thiếu timestamp không đủ bằng chứng để phát nhắc hồi tố.
  return createdAt instanceof Date && createdAt <= dueAt;
}

export function membershipIneligibility(input: { status: string; createdAt?: Date; startDate: string; endDate: string;
  transaction?: { status: string; kind: string; settled_at?: Date }; now: Date; dueAt: Date; hasContinuation?: boolean }): string | undefined {
  const { transaction, dueAt } = input;
  if (input.status !== 'ACTIVE') return 'MEMBERSHIP_NOT_ACTIVE';
  if (!transaction || transaction.status !== 'SETTLED' || !['GYM', 'PT'].includes(transaction.kind)) return 'NOT_SETTLED';
  if (!existedAt(input.createdAt, dueAt) || !existedAt(transaction.settled_at, dueAt)) return 'CREATED_AFTER_DUE';
  const today = vietnamDay(input.now);
  if (input.startDate > today || input.endDate < today) return 'OUTSIDE_MEMBERSHIP_PERIOD';
  if (input.hasContinuation) return 'SETTLED_CONTINUATION';
  return undefined;
}

export function bookingIneligibility(status: string, createdAt: Date, dueAt: Date): string | undefined {
  if (status !== 'BOOKED') return 'BOOKING_NOT_BOOKED';
  return existedAt(createdAt, dueAt) ? undefined : 'CREATED_AFTER_DUE';
}

export function reminderEventKey(type: ReminderSource, id: string, milestone: ReminderMilestone): string {
  return `${type === 'MEMBERSHIP' ? 'MEMBERSHIP_REMINDER' : 'PT_REMINDER'}:${id}:${milestone}`;
}
