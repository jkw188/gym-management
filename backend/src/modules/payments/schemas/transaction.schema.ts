// Tầng dữ liệu (US-17 bước 1): cấu trúc collection transactions theo báo cáo mục 4.2.10 – nghĩa vụ thanh toán của một lần bán.
// US-17 chỉ ĐỌC; tạo/xác nhận thu thuộc US-14/22. Index unique request_key do EN-02 tạo.
import { Schema, Types } from 'mongoose';

export type TransactionKind = 'RETAIL' | 'GYM' | 'PT';
export type TransactionStatus = 'PENDING' | 'SETTLED' | 'CANCELLED';

export interface Transaction {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  member_id?: Types.ObjectId;         // chủ sở hữu; bán lẻ khách vãng lai có thể không có
  created_by: Types.ObjectId;         // nội bộ, không trả cho Member
  code: string;
  kind: TransactionKind;
  amount_due: Types.Decimal128;
  status: TransactionStatus;
  request_key: string;                // nội bộ (chống tạo trùng), không trả cho Member
  created_at: Date;
  guard_revision: bigint;             // EN-02: khóa dữ liệu khi ghi (data-guards.service.ts), nội bộ, không trả cho Member
}

export const TransactionSchema = new Schema<Transaction>({
  id: { type: Schema.Types.ObjectId, required: true },
  member_id: { type: Schema.Types.ObjectId, ref: 'Member' },
  created_by: { type: Schema.Types.ObjectId, required: true },
  code: { type: String, required: true, maxlength: 40 },
  kind: { type: String, required: true, maxlength: 10, enum: ['RETAIL', 'GYM', 'PT'] },
  amount_due: { type: Schema.Types.Decimal128, required: true },
  status: { type: String, required: true, maxlength: 20, enum: ['PENDING', 'SETTLED', 'CANCELLED'] },
  request_key: { type: String, required: true, maxlength: 80 },
  created_at: { type: Date, required: true },
  // EN-02 (financial-integrity.ts): Int64 ≥ 0, mặc định 0; cùng khuôn với members.service_revision.
  guard_revision: { type: Schema.Types.BigInt, required: true, default: 0n, validate: (value: bigint) => value >= 0n },
}, { collection: 'transactions', id: false, versionKey: false });
