import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { SalesRepository } from './sales.repository';

@Injectable()
export class UpgradesRepository {
  constructor(private readonly sales: SalesRepository) {}
  async source(memberId: Types.ObjectId, membershipId: Types.ObjectId, session?: ClientSession) {
    const membership = await this.sales.memberships.findById(membershipId).session(session ?? null).lean().exec();
    if (!membership) return null;
    const sale = await this.sales.sales.findOne({ _id: membership.service_sale_id, member_id: memberId }).session(session ?? null).lean().exec();
    if (!sale) return null;
    const transaction = await this.sales.transactions.findOne({ _id: sale.transaction_id, member_id: memberId }).session(session ?? null).lean().exec();
    return { membership, sale, transaction };
  }
  async futurePeriod(memberId: Types.ObjectId, kind: 'GYM' | 'PT', today: string, session?: ClientSession) {
    const transactions = await this.sales.transactions.find({ member_id: memberId, kind, status: 'SETTLED' }, { _id: 1 }).session(session ?? null).lean().exec();
    const sales = await this.sales.sales.find({ member_id: memberId, transaction_id: { $in: transactions.map(row => row._id) }, start_date: { $gt: today } }, { _id: 1 })
      .session(session ?? null).lean().exec();
    return !!await this.sales.memberships.exists({ service_sale_id: { $in: sales.map(row => row._id) }, status: 'ACTIVE' }).session(session ?? null);
  }
}
