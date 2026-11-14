// Tầng dữ liệu (US-17 bước 1): cấu trúc collection payments theo báo cáo mục 4.2.23 – một lần thu tiền cho một transaction.
// US-17 chỉ ĐỌC method/amount/paid_at; reference và verified_by là thông tin đối chiếu nội bộ (US-17-F04).
import { Schema, Types } from 'mongoose';
import { fromVndDecimal } from '../../../common/utils/vnd-money';

export type PaymentMethod = 'CASH' | 'TRANSFER';
export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface Payment {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  transaction_id: Types.ObjectId;
  method: PaymentMethod;
  reference: string;
  amount: Types.Decimal128;
  status: PaymentStatus;
  verified_by?: Types.ObjectId;
  paid_at?: Date;
  verified_at?: Date;
  evidence_note?: string;
  receiving_account_code?: string;
  bank_reference?: string;
  created_at?: Date;
}

export const PaymentSchema = new Schema<Payment>({
  id: { type: Schema.Types.ObjectId, required: true },
  transaction_id: { type: Schema.Types.ObjectId, ref: 'Transaction', required: true },
  method: { type: String, required: true, maxlength: 20, enum: ['CASH', 'TRANSFER'] },
  reference: { type: String, required: true, maxlength: 100 },
  amount: { type: Schema.Types.Decimal128, required: true, validate: function (this: Payment, value: Types.Decimal128) {
    if (this.status !== 'SUCCEEDED') return true;
    try { return fromVndDecimal(value) !== '0'; } catch { return false; }
  } },
  status: { type: String, required: true, maxlength: 20, enum: ['PENDING', 'SUCCEEDED', 'FAILED'] },
  verified_by: { type: Schema.Types.ObjectId, required: function (this: Payment) { return this.status === 'SUCCEEDED'; } },
  paid_at: { type: Date, required: function (this: Payment) { return this.status === 'SUCCEEDED'; } },
  verified_at: { type: Date },
  evidence_note: { type: String, maxlength: 500 },
  receiving_account_code: { type: String, maxlength: 40 },
  bank_reference: { type: String, maxlength: 100 },
  created_at: { type: Date, default: Date.now },
}, { collection: 'payments', id: false, versionKey: false });
PaymentSchema.index({ transaction_id: 1 }, { name: 'payments_transaction' });
