import { model, Types } from 'mongoose';
import { PaymentSchema } from '../src/modules/payments/schemas/payment.schema';

const PaymentModel = model('US22PaymentValidation', PaymentSchema);
const values = () => {
  const id = new Types.ObjectId();
  return { _id: id, id, transaction_id: new Types.ObjectId(), method: 'CASH', reference: `CASH:${id}`, amount: '300000', status: 'SUCCEEDED',
    verified_by: new Types.ObjectId(), paid_at: new Date(), evidence_note: 'Đã kiểm đếm đủ tiền thật' };
};
describe('US22 payment schema invariants, retaining historical payment statuses', () => {
  it('requires verifier and actual receipt timestamp on a successful payment', async () => {
    const row = new PaymentModel(values()); row.verified_by = undefined; row.paid_at = undefined;
    await expect(row.validate()).rejects.toMatchObject({ errors: { verified_by: expect.anything(), paid_at: expect.anything() } });
  });
  it.each(['0', '-1', '1.5', '1000000000000'])('rejects invalid successful payment amount %s', async amount => {
    await expect(new PaymentModel({ ...values(), amount }).validate()).rejects.toMatchObject({ errors: { amount: expect.anything() } });
  });
  it('accepts a full positive payment and supplies created_at without requiring new metadata on historical rows', async () => {
    const row = new PaymentModel(values()); await expect(row.validate()).resolves.toBeUndefined();
    expect(row.created_at).toBeInstanceOf(Date);
    for (const status of ['PENDING', 'FAILED']) {
      const legacy = new PaymentModel({ ...values(), status, amount: '0', verified_by: undefined, paid_at: undefined });
      await expect(legacy.validate()).resolves.toBeUndefined();
    }
  });
});
