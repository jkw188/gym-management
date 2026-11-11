// Tầng dữ liệu (US-17 bước 1): cấu trúc collection service_sales theo báo cáo mục 4.2.11 – mỗi document là một lần bán gói.
// US-17 chỉ ĐỌC; luồng tạo/hủy sale thuộc US-14/16. Index unique transaction_id do EN-02 (financial-integrity.ts) tạo.
import { Schema, Types } from 'mongoose';

export type SaleOperation = 'REGISTER' | 'RENEW' | 'UPGRADE';

export interface ServiceSale {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  transaction_id: Types.ObjectId;
  member_id: Types.ObjectId;          // chủ sở hữu của sale (US-17-F01)
  plan_id: Types.ObjectId;
  operation: SaleOperation;
  previous_sale_id?: Types.ObjectId;
  start_date: string;                 // YYYY-MM-DD theo giờ Việt Nam
  end_date: string;
  plan_name_snapshot: string;         // US-17-F02: hiển thị theo snapshot lúc bán, không theo gói hiện tại
  benefits_snapshot: string;
  list_price_snapshot: Types.Decimal128;
  credit_amount: Types.Decimal128;
  sessions_snapshot: number;
  policy_snapshot: string;
}

export const ServiceSaleSchema = new Schema<ServiceSale>({
  id: { type: Schema.Types.ObjectId, required: true },
  transaction_id: { type: Schema.Types.ObjectId, ref: 'Transaction', required: true },
  member_id: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
  plan_id: { type: Schema.Types.ObjectId, required: true },
  operation: { type: String, required: true, maxlength: 20, enum: ['REGISTER', 'RENEW', 'UPGRADE'] },
  previous_sale_id: { type: Schema.Types.ObjectId, ref: 'ServiceSale' },
  start_date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  end_date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  plan_name_snapshot: { type: String, required: true, maxlength: 120 },
  benefits_snapshot: { type: String, required: true, maxlength: 1000 },
  list_price_snapshot: { type: Schema.Types.Decimal128, required: true },
  credit_amount: { type: Schema.Types.Decimal128, required: true },
  sessions_snapshot: { type: Schema.Types.Int32, required: true, min: 0 },
  policy_snapshot: { type: String, required: true, maxlength: 2000 },
}, { collection: 'service_sales', id: false, versionKey: false });

// Spec US-17 mục 2: index service_sales.member_id để lọc theo chủ sở hữu ngay trong DB, xếp mới nhất trước.
ServiceSaleSchema.index({ member_id: 1, _id: -1 }, { name: 'service_sales_member_desc' });
