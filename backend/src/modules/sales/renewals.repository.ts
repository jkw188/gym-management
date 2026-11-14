import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { SalesRepository } from './sales.repository';

@Injectable()
export class RenewalsRepository {
  constructor(private readonly repository: SalesRepository) {}

  async source(memberId: Types.ObjectId, saleId: Types.ObjectId, session?: ClientSession) {
    const sale = await this.repository.sales.findOne({ _id: saleId, member_id: memberId }).session(session ?? null).lean().exec();
    if (!sale) return null;
    const transaction = await this.repository.transactions.findOne({ _id: sale.transaction_id, member_id: memberId }).session(session ?? null).lean().exec();
    const membership = await this.repository.memberships.findOne({ service_sale_id: saleId }).session(session ?? null).lean().exec();
    return { sale, transaction, membership };
  }

  async isLatest(memberId: Types.ObjectId, kind: 'GYM' | 'PT', saleId: Types.ObjectId, session?: ClientSession) {
    const settled = await this.repository.transactions.find({ member_id: memberId, kind, status: 'SETTLED' }, { _id: 1 })
      .session(session ?? null).lean().exec();
    const filter = { member_id: memberId, transaction_id: { $in: settled.map(item => item._id) } };
    const latest = await this.repository.sales.findOne(filter).sort({ end_date: -1, _id: -1 }).session(session ?? null).lean().exec();
    if (!latest?._id.equals(saleId)) return false;
    return !await this.repository.sales.exists({ ...filter, previous_sale_id: saleId }).session(session ?? null);
  }

  async pending(memberId: Types.ObjectId, kind: 'GYM' | 'PT', session?: ClientSession, excludedTransactionId?: Types.ObjectId) {
    const transactions = await this.repository.transactions.find({ member_id: memberId, kind, status: 'PENDING',
      ...(excludedTransactionId ? { _id: { $ne: excludedTransactionId } } : {}) }, { _id: 1 }).session(session ?? null).lean().exec();
    return !!await this.repository.sales.exists({ member_id: memberId, transaction_id: { $in: transactions.map(item => item._id) } }).session(session ?? null);
  }
}
