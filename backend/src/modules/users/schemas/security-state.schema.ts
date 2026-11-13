import { Schema } from 'mongoose';

export const ACCOUNT_ADMINISTRATION = 'account-administration';
export interface SecurityState { _id: string; revision: bigint }
export const SecurityStateSchema = new Schema<SecurityState>({
  _id: { type: String, required: true, enum: [ACCOUNT_ADMINISTRATION] },
  revision: { type: Schema.Types.BigInt, required: true, validate: (value: bigint) => value >= 0n },
}, { collection: 'security_state', versionKey: false, strict: 'throw' });
