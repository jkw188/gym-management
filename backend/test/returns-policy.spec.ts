import { assertReturnWindow, returnDeadline } from '../src/modules/returns/return.policy';
import { payoutReference } from '../src/modules/refunds/refund-payout.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfirmRefundDto } from '../src/modules/refunds/refunds.dto';
import { readPayoutAccounts } from '../src/config/configuration';

describe('US46 policies', () => {
  it('counts the delivery date as day one, rather than 168 hours', () => {
    const delivered = new Date('2026-11-15T23:50:00+07:00');
    expect(returnDeadline(delivered).toISOString()).toBe('2026-11-21T17:00:00.000Z');
    expect(() => assertReturnWindow(delivered, new Date('2026-11-21T23:59:59.999+07:00'))).not.toThrow();
    expect(() => assertReturnWindow(delivered, new Date('2026-11-22T00:00:00+07:00'))).toThrow();
    expect(() => assertReturnWindow(delivered, new Date('2026-11-15T23:49:59+07:00'))).toThrow();
  });
  it('normalizes payout references and keeps method/account namespaces separate', () => {
    const base: ConfirmRefundDto = { version: 0, method: 'CASH', amount: '1', evidenceNote: 'Đã đối chiếu chứng từ', paidOutAt: '2026-11-17T00:00:00Z', cashVoucherReference: ' abc-01 ' };
    expect(payoutReference(base)).toBe(payoutReference({ ...base, cashVoucherReference: 'ABC-01' }));
    expect(() => payoutReference({ ...base, cashVoucherReference: 'RF:internal' })).toThrow();
    const transfer: ConfirmRefundDto = { version: 0, method: 'TRANSFER', amount: '1', evidenceNote: base.evidenceNote, paidOutAt: base.paidOutAt, bankReference: 'abc-01', payoutAccountCode: 'A' };
    expect(payoutReference(transfer)).not.toBe(payoutReference({ ...transfer, payoutAccountCode: 'B' }));
    expect(() => payoutReference({ ...transfer, cashVoucherReference: '1' })).toThrow();
  });
  it('has a separate paying-account allowlist, disabled by default', () => {
    expect(readPayoutAccounts({ RECEIVING_ACCOUNTS: '["RECEIVE"]' })).toEqual([]);
    expect(readPayoutAccounts({ PAYOUT_ACCOUNTS: '["GYM_PAYOUT"]' })).toEqual(['GYM_PAYOUT']);
    expect(() => readPayoutAccounts({ PAYOUT_ACCOUNTS: '["a"]' })).toThrow('PAYOUT_ACCOUNTS');
  });
  it('rejects missing evidence, wrong money types and timestamps without timezone', async () => {
    const body = { version: 0, method: 'CASH', amount: '1', evidenceNote: 'Bằng chứng thực chi hợp lệ', cashVoucherReference: 'V1', paidOutAt: '2026-11-17T00:00:00Z' };
    for (const patch of [{ amount: 1 }, { amount: '-1' }, { amount: '1000000000000' }, { evidenceNote: 'short' }, { paidOutAt: '2026-11-17T00:00:00' }]) {
      expect((await validate(plainToInstance(ConfirmRefundDto, { ...body, ...patch }))).length).toBeGreaterThan(0);
    }
  });
});
