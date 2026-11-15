import { valueUpgrade } from '../src/modules/sales/upgrade-valuation';

describe('US-16-D01/D02: decimal/calendar valuation', () => {
  const quote = (extra = {}) => valueUpgrade({ startDate: '2026-11-01', endDate: '2026-11-30', asOfDate: '2026-11-16',
    sourceAmountDue: '900000', sourceCredit: '0', targetListPrice: '1500000', ...extra });
  it('TC05: includes upgrade day, 900000 / 30 * 15 = 450000', () => {
    expect(quote()).toMatchObject({ baseValue: '900000', totalDays: 30, remainingDays: 15, rawCredit: '450000', amountDue: '1050000', quoteExpiresAt: '2026-11-16T17:00:00.000Z' });
  });
  it.each([['1', '1'], ['3', '2'], ['999999999999', '500000000000']])('TC06: exactly half of %s rounds half-up to %s without float', (amount, raw) => {
    expect(quote({ startDate: '2028-02-28', endDate: '2028-02-29', asOfDate: '2028-02-29', sourceAmountDue: amount, targetListPrice: '999999999999' }).rawCredit).toBe(raw);
  });
  it('TC07/08: caps applied credit and drops excess; next base uses only paid + applied', () => {
    const first = quote({ asOfDate: '2026-11-11', targetListPrice: '500000' });
    expect(first).toMatchObject({ rawCredit: '600000', appliedCredit: '500000', excessCredit: '100000', amountDue: '0' });
    expect(quote({ sourceAmountDue: first.amountDue, sourceCredit: first.appliedCredit, asOfDate: '2026-11-01' }).baseValue).toBe('500000');
  });
  it('counts final day and calendar years correctly', () => {
    expect(quote({ asOfDate: '2026-11-30' })).toMatchObject({ remainingDays: 1, rawCredit: '30000' });
    expect(quote({ startDate: '2028-02-28', endDate: '2028-03-01', asOfDate: '2028-02-29' }).totalDays).toBe(3);
  });
});
