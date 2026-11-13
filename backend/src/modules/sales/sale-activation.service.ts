import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock, membershipEndDate } from '../../common/utils/business-date';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { SalesRepository } from './sales.repository';

export interface ActivationTarget { saleId: Types.ObjectId; memberId: Types.ObjectId; transactionId: Types.ObjectId }
export interface ActivationResult { membershipId: string; startDate: string; endDate: string }

// US-22 can prepare verified payment/invoice after these locks via prepareSettlement, in the existing session.
// It acquires member -> transaction once; callers must not acquire the same guards separately.
export abstract class SaleActivation {
  abstract activateSaleWithinSession(session: ClientSession, target: ActivationTarget,
    prepareSettlement?: () => Promise<void>): Promise<ActivationResult>;
}

@Injectable()
export class SaleActivationService extends SaleActivation {
  constructor(private readonly repository: SalesRepository, private readonly guards: DataGuardsService,
    private readonly clock: ServerClock) { super(); }

  async activateSaleWithinSession(session: ClientSession, target: ActivationTarget,
    prepareSettlement?: () => Promise<void>): Promise<ActivationResult> {
    if (!session.inTransaction()) throw new Error('SALE_TRANSACTION_REQUIRED');
    await this.guards.acquire(session, { members: [target.memberId], transactions: [target.transactionId] });
    const transaction = await this.repository.transactions.findById(target.transactionId).session(session).lean().exec();
    if (!transaction || transaction.status !== 'PENDING' || !transaction.member_id?.equals(target.memberId)) throw invalidState();
    if (prepareSettlement) await prepareSettlement();
    // Payment verification belongs to settlement. Activation never grants a paid plan without evidence of full collection.
    if (fromVndDecimal(transaction.amount_due) !== '0') {
      const payment = await this.repository.payments.findOne({ transaction_id: target.transactionId, status: 'SUCCEEDED' })
        .session(session).lean().exec();
      if (!payment || fromVndDecimal(payment.amount) !== fromVndDecimal(transaction.amount_due)) throw invalidState();
    }
    return this.activateLocked(session, target);
  }

  // Creation owns the plan/member locks; the transaction is new and invisible to other sessions.
  // Only the zero-completion path uses this method. No second/nested transaction or guard acquisition.
  async activateNewFreeSaleWithinSession(session: ClientSession, target: ActivationTarget): Promise<ActivationResult> {
    if (!session.inTransaction()) throw new Error('SALE_TRANSACTION_REQUIRED');
    const transaction = await this.repository.transactions.findById(target.transactionId).session(session).lean().exec();
    if (!transaction || transaction.status !== 'PENDING' || fromVndDecimal(transaction.amount_due) !== '0' ||
      !transaction.member_id?.equals(target.memberId)) throw invalidState();
    return this.activateLocked(session, target);
  }

  private async activateLocked(session: ClientSession, target: ActivationTarget): Promise<ActivationResult> {
    const sale = await this.repository.sales.findOne({ _id: target.saleId, member_id: target.memberId, transaction_id: target.transactionId })
      .session(session).lean().exec();
    if (!sale || sale.operation !== 'REGISTER' || !sale.requested_start_date || !sale.duration_days_snapshot || !sale.kind_snapshot) throw invalidState();
    const transaction = await this.repository.transactions.findById(target.transactionId).session(session).lean().exec();
    if (!transaction || transaction.kind !== sale.kind_snapshot || fromVndDecimal(sale.credit_amount) !== '0' ||
      fromVndDecimal(transaction.amount_due) !== fromVndDecimal(sale.list_price_snapshot)) throw invalidState();
    const today = this.clock.today();
    const blocked = await this.repository.blockingCode(target.memberId, sale.kind_snapshot, today, session, target.transactionId);
    if (blocked) throw new ApplicationError(409, blocked, 'Hội viên đã có gói hoặc giao dịch chờ cùng loại');
    if (await this.repository.memberships.exists({ service_sale_id: sale._id }).session(session)) throw invalidState();
    const startDate = sale.requested_start_date > today ? sale.requested_start_date : today;
    const endDate = membershipEndDate(startDate, sale.duration_days_snapshot);
    await this.repository.sales.updateOne({ _id: sale._id }, { $set: { start_date: startDate, end_date: endDate } }, { session, runValidators: true });
    const id = new Types.ObjectId();
    await this.repository.memberships.create([{ _id: id, id, service_sale_id: sale._id, status: 'ACTIVE', sessions_used: 0,
      created_at: this.clock.now(), version: 0 }], { session });
    return { membershipId: id.toHexString(), startDate, endDate };
  }
}

export function invalidState() { return new ApplicationError(409, 'INVALID_TRANSACTION_STATE', 'Trạng thái giao dịch không cho phép thao tác'); }
