import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../errors/application-error';

const vietnamDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
});

// Injectable server clock; tests can override it without accepting a client-provided "now".
@Injectable()
export class ServerClock {
  now(): Date { return new Date(); }
  today(): string {
    const parts = vietnamDate.formatToParts(this.now());
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
}

export function assertBusinessDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) throw invalidDate();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalidDate();
  return value;
}

export function addCalendarDays(value: string, days: number): string {
  assertBusinessDate(value);
  if (!Number.isSafeInteger(days)) throw invalidDate();
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  if (!Number.isFinite(date.getTime())) throw invalidDate();
  return assertBusinessDate(date.toISOString().slice(0, 10));
}

export function membershipEndDate(startDate: string, durationDays: number): string {
  if (!Number.isSafeInteger(durationDays) || durationDays < 1) throw invalidDate();
  return addCalendarDays(startDate, durationDays - 1);
}

function invalidDate() {
  return new ApplicationError(400, 'VALIDATION_ERROR', 'Ngày phải là YYYY-MM-DD hợp lệ và thời hạn phải là số ngày nguyên dương');
}
