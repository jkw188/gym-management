import { Schema, Types } from 'mongoose';

export const VERIFICATION_METHODS = ['IN_PERSON_ACCOUNT', 'IN_PERSON_DOCUMENT'] as const;
export type VerificationMethod = typeof VERIFICATION_METHODS[number];
export interface MemberLinkEvent {
  _id: Types.ObjectId; member_id: Types.ObjectId; account_id: Types.ObjectId;
  verified_by: Types.ObjectId; verified_at: Date; verification_method: VerificationMethod;
  verification_note: string; request_key: string;
}
export const MemberLinkEventSchema = new Schema<MemberLinkEvent>({
  member_id: { type: Schema.Types.ObjectId, required: true },
  account_id: { type: Schema.Types.ObjectId, required: true },
  verified_by: { type: Schema.Types.ObjectId, required: true },
  verified_at: { type: Date, required: true },
  verification_method: { type: String, required: true, enum: VERIFICATION_METHODS },
  verification_note: { type: String, required: true, minlength: 10, maxlength: 500 },
  request_key: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
}, { collection: 'member_link_events', versionKey: false, strict: 'throw' });
MemberLinkEventSchema.index({ member_id: 1 }, { unique: true, name: 'member_link_events_member_unique' });
MemberLinkEventSchema.index({ request_key: 1 }, { unique: true, name: 'member_link_events_request_unique' });
