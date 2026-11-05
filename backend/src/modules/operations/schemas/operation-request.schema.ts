// Tầng dữ liệu (EN-02 bước 2): cấu trúc collection operation_requests, mỗi record là kết quả đã commit của một lệnh có Idempotency-Key.
// Không lưu credential, mật khẩu thô hay secret; record chỉ được insert trong transaction thành công (EN-02-D01).
import { Schema, Types } from 'mongoose';

// EN-02-D01: các thao tác bắt buộc có Idempotency-Key.
export const OPERATIONS = ['SALE_REGISTER', 'SALE_CANCEL', 'PAYMENT_CONFIRM', 'MEMBER_CREATE', 'MEMBER_LINK'] as const;
export type Operation = (typeof OPERATIONS)[number];

export interface OperationRequest {
  _id: Types.ObjectId;
  actor_id: Types.ObjectId;
  operation: Operation;
  client_key: string;
  request_hash: string;
  result_ids: Record<string, unknown>;
  response_status: number;
  response_body: Record<string, unknown>;
  committed_at: Date;
}

export const OperationRequestSchema = new Schema<OperationRequest>({
  // actor_id lấy từ người đang đăng nhập, không nhận từ client (EN-02-F04).
  actor_id: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  operation: { type: String, required: true, enum: OPERATIONS },
  // UUID v4 do client tạo trong header Idempotency-Key.
  client_key: { type: String, required: true, match: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i },
  // SHA-256 (64 ký tự hex) của DTO đã chuẩn hóa cộng targetId.
  request_hash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  result_ids: { type: Schema.Types.Mixed, required: true, default: {} },
  response_status: { type: Schema.Types.Int32, required: true },
  response_body: { type: Schema.Types.Mixed, required: true, default: {} },
  committed_at: { type: Date, required: true },
}, { collection: 'operation_requests', versionKey: false, strict: 'throw', minimize: false });

// EN-02-D01, EN-02-TC02: một actor + một thao tác + một key chỉ có một kết quả. Không có TTL vì là khóa tài chính.
OperationRequestSchema.index({ actor_id: 1, operation: 1, client_key: 1 }, { unique: true, name: 'operation_requests_actor_operation_key_unique' });
