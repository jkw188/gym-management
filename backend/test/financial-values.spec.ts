import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { addVnd, assertPaymentAmount, fromVndDecimal, normalizeVnd, subtractVnd, toVndDecimal } from '../src/common/utils/vnd-money';
import { addCalendarDays, assertBusinessDate, membershipEndDate, ServerClock } from '../src/common/utils/business-date';
import { ReceivingAccountPolicy } from '../src/common/utils/receiving-account';
import { readReceivingAccounts } from '../src/config/configuration';

describe('EN-02-D02 / TC13: VND decimal strings', () => {
  it.each([1, 1.5, -1, NaN, Infinity, null, '', '1e3', '1.0', '-1', '+1', ' 1', '1,000', '1000000000000'])('rejects %p', value => {
    expect(() => normalizeVnd(value)).toThrow();
  });
  it('normalizes only integer strings and round-trips Decimal128', () => {
    expect(normalizeVnd('00015')).toBe('15');
    expect(normalizeVnd('0000000000000001')).toBe('1');
    expect(toVndDecimal('999999999999')).toBeInstanceOf(Types.Decimal128);
    expect(fromVndDecimal(toVndDecimal('999999999999'))).toBe('999999999999');
    expect(fromVndDecimal(Types.Decimal128.fromString('1E+3'))).toBe('1000');
    expect(() => fromVndDecimal(Types.Decimal128.fromString('0.5'))).toThrow();
  });
  it('calculates in decimal, rejects underflow/overflow and validates successful payment', () => {
    expect(addVnd('999999999998', '1')).toBe('999999999999');
    expect(subtractVnd('150000', '50000')).toBe('100000');
    expect(() => addVnd('999999999999', '1')).toThrow();
    expect(() => subtractVnd('1', '2')).toThrow();
    expect(assertPaymentAmount('001000', '1000')).toBe('1000');
    expect(() => assertPaymentAmount('0', '0')).toThrow();
    expect(() => assertPaymentAmount('1000', '2000')).toThrow();
  });
});

describe('EN-02-D03 / TC14: calendar days and Vietnam server clock', () => {
  it.each(['2025-02-29', '2026-04-31', '2026-2-01', '0000-01-01', '2026-11-08T00:00:00Z'])('rejects invalid date %s', value => {
    expect(() => assertBusinessDate(value)).toThrow();
  });
  it('handles leap day, month/year boundaries and inclusive duration', () => {
    expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(membershipEndDate('2024-02-28', 3)).toBe('2024-03-01');
    expect(membershipEndDate('2026-12-31', 2)).toBe('2027-01-01');
    expect(membershipEndDate('2026-11-08', 1)).toBe('2026-11-08');
    expect(() => membershipEndDate('2026-11-08', 0)).toThrow();
    expect(() => addCalendarDays('9999-12-31', 1)).toThrow();
  });
  it('uses Asia/Ho_Chi_Minh even when UTC is the previous day', () => {
    const clock = new ServerClock();
    jest.spyOn(clock, 'now').mockReturnValue(new Date('2026-11-07T17:00:00.000Z'));
    expect(clock.today()).toBe('2026-11-08');
    jest.restoreAllMocks();
  });
});

describe('EN-02 receiving-account configuration', () => {
  it('does not require transfer configuration to start/CASH; TRANSFER fails closed', () => {
    expect(readReceivingAccounts({})).toEqual([]);
    expect(() => new ReceivingAccountPolicy(new ConfigService({ receivingAccounts: [] })).assertTransferAllowed('MAIN')).toThrow();
  });
  it('accepts only configured public codes and validates configuration without leaking values', () => {
    expect(readReceivingAccounts({ RECEIVING_ACCOUNTS: '["MAIN_VND"]' })).toEqual(['MAIN_VND']);
    const policy = new ReceivingAccountPolicy(new ConfigService({ receivingAccounts: ['MAIN_VND'] }));
    expect(() => policy.assertTransferAllowed('MAIN_VND')).not.toThrow();
    expect(() => policy.assertTransferAllowed('OTHER')).toThrow();
    for (const value of ['{}', '["MAIN","MAIN"]', '["bank-secret:xxx"]', 'bad']) {
      expect(() => readReceivingAccounts({ RECEIVING_ACCOUNTS: value })).toThrow('Invalid environment variables: RECEIVING_ACCOUNTS');
    }
  });
});
