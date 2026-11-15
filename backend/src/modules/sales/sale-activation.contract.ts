import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';

export interface ActivationTarget { saleId: Types.ObjectId; memberId: Types.ObjectId; transactionId: Types.ObjectId }
export interface ActivationResult { membershipId: string; startDate: string; endDate: string }

export abstract class SaleActivation {
  abstract activateSaleWithinSession(session: ClientSession, target: ActivationTarget,
    prepareSettlement?: () => Promise<void>): Promise<ActivationResult>;
}

export function invalidState() { return new ApplicationError(409, 'INVALID_TRANSACTION_STATE', 'Trạng thái giao dịch không cho phép thao tác'); }
