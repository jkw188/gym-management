// Tầng dữ liệu (US-17 bước 1): cấu trúc collection memberships theo báo cáo mục 4.2.12 – kỳ gói được cấp từ một sale.
// Chủ sở hữu suy ra qua service_sale_id → service_sales.member_id. Index unique service_sale_id do EN-02 tạo.
import { Schema, Types } from 'mongoose';

export type MembershipStatus = 'ACTIVE' | 'SUPERSEDED' | 'CANCELLED';

export interface Membership {
  _id: Types.ObjectId;
  id: Types.ObjectId;
  service_sale_id: Types.ObjectId;
  status: MembershipStatus;           // US-17-F02: storedStatus giữ đúng như trong DB
  sessions_used: number;
  created_at?: Date;
  version: number;
}

export const MembershipSchema = new Schema<Membership>({
  id: { type: Schema.Types.ObjectId, required: true },
  service_sale_id: { type: Schema.Types.ObjectId, ref: 'ServiceSale', required: true },
  status: { type: String, required: true, maxlength: 20, enum: ['ACTIVE', 'SUPERSEDED', 'CANCELLED'] },
  sessions_used: { type: Schema.Types.Int32, required: true, min: 0 },
  created_at: { type: Date },
  version: { type: Number, required: true, default: 0, min: 0, validate: Number.isSafeInteger },
}, { collection: 'memberships', id: false, versionKey: false });
MembershipSchema.index({ service_sale_id: 1 }, { unique: true, name: 'memberships_sale_unique' });
