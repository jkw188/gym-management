// Tầng dữ liệu (US-09 bước 3): collection member_link_events, mỗi document ghi lại một lần liên kết hồ sơ với account.
// Ghi cùng transaction với members.account_id; S02 chưa có hủy liên kết nên mỗi hồ sơ có tối đa một bản ghi.
import { Schema, Types } from 'mongoose';

export const VERIFICATION_METHODS = ['IN_PERSON_ACCOUNT', 'IN_PERSON_DOCUMENT'] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export interface MemberLinkEvent {
  _id: Types.ObjectId;
  member_id: Types.ObjectId;
  account_id: Types.ObjectId;
  verified_by: Types.ObjectId;
  verified_at: Date;
  verification_method: VerificationMethod;
  verification_note: string;
  request_key: string;
}

export const MemberLinkEventSchema = new Schema<MemberLinkEvent>({
  member_id: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
  account_id: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  // US-09-F05: nhân viên thực hiện và thời điểm lấy từ server, không nhận từ client.
  verified_by: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
  verified_at: { type: Date, required: true },
  verification_method: { type: String, required: true, enum: VERIFICATION_METHODS },
  verification_note: { type: String, required: true, minlength: 10, maxlength: 500 },
  // "MEMBER_LINK:<actor>:<Idempotency-Key>", giống request_key của shift_events.
  request_key: { type: String, required: true, maxlength: 120 },
}, { collection: 'member_link_events', versionKey: false, strict: 'throw' });

// US-09-TC08: một hồ sơ chỉ có một bản ghi liên kết; cùng request_key chỉ có một audit.
MemberLinkEventSchema.index({ member_id: 1 }, { unique: true, name: 'member_link_events_member_id_unique' });
MemberLinkEventSchema.index({ request_key: 1 }, { unique: true, name: 'member_link_events_request_key_unique' });
