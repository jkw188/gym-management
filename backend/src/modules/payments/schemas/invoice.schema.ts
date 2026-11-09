// Tầng dữ liệu (US-17 bước 1): cấu trúc collection invoices theo báo cáo mục 4.2.24 – chứng từ của một transaction.
// Chủ sở hữu suy ra qua transaction_id → transactions.member_id. Index unique transaction_id, invoice_no do EN-02 tạo.
import { Schema, Types } from 'mongoose';

export interface Invoice {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  transaction_id: Types.ObjectId;
  invoice_no: string;
  issued_at: Date;
  total_amount: Types.Decimal128;
  buyer_snapshot: string;             // US-17-F04: người mua chốt lúc lập, không đổi theo hồ sơ hiện tại
}

export const InvoiceSchema = new Schema<Invoice>({
  id: { type: Schema.Types.ObjectId, required: true },
  transaction_id: { type: Schema.Types.ObjectId, ref: 'Transaction', required: true },
  invoice_no: { type: String, required: true, maxlength: 40 },
  issued_at: { type: Date, required: true },
  total_amount: { type: Schema.Types.Decimal128, required: true },
  buyer_snapshot: { type: String, required: true, maxlength: 1000 },
}, { collection: 'invoices', id: false, versionKey: false });
