import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Document, ObjectId } from 'mongodb';
import { Connection, Types } from 'mongoose';
import { Member } from './schemas/member.schema';
import { MemberPaginationDto, MembersQueryDto, ServiceKind } from './members-query.dto';

interface Facet<T> { items: T[]; count: { total: number }[] }
export interface StateGroup { _id: ServiceKind; states: ('CURRENT' | 'SCHEDULED' | 'EXPIRED')[] }
export interface ReadMember extends Member { entitlement: StateGroup[] }
export interface ReadMembership {
  _id: ObjectId; sale_id: ObjectId; kind: ServiceKind; plan_name: string; start_date: string; end_date: string;
  stored_status: string; transaction_status: string; sessions_quota: number; sessions_used: number;
}
export interface ReadTransaction {
  _id: ObjectId; code: string; kind: string; status: string; amount_due: Types.Decimal128; created_at: Date;
  payments: { _id: ObjectId }[]; invoices: { _id: ObjectId }[];
}

// Những collection tài chính do US-14/21/22 sở hữu. Chỉ đọc projection theo mục 4.2.10–12, 23–24;
// không đăng ký schema giả, tạo dữ liệu demo hoặc thay đổi state machine của các module đó.
@Injectable()
export class MembersQueryRepository {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  private transactionJoin(): Document[] {
    return [{ $lookup: { from: 'transactions', localField: 'transaction_id', foreignField: '_id',
      let: { owner: '$member_id' }, pipeline: [
        { $match: { $expr: { $eq: ['$member_id', '$$owner'] } } },
        { $project: { kind: 1, status: 1, created_at: 1 } },
      ], as: 'transaction' } }, { $unwind: '$transaction' }];
  }

  private entitlement(today: string): Document {
    return { $lookup: { from: 'service_sales', localField: '_id', foreignField: 'member_id', pipeline: [
      { $project: { member_id: 1, transaction_id: 1, start_date: 1, end_date: 1 } },
      ...this.transactionJoin(),
      { $match: { 'transaction.status': 'SETTLED', 'transaction.kind': { $in: ['GYM', 'PT'] } } },
      { $lookup: { from: 'memberships', localField: '_id', foreignField: 'service_sale_id',
        pipeline: [{ $match: { status: 'ACTIVE' } }, { $project: { _id: 1 } }], as: 'membership' } },
      { $match: { 'membership.0': { $exists: true } } },
      { $group: { _id: '$transaction.kind', states: { $addToSet: { $switch: { branches: [
        { case: { $gt: ['$start_date', today] }, then: 'SCHEDULED' },
        { case: { $lt: ['$end_date', today] }, then: 'EXPIRED' },
      ], default: 'CURRENT' } } } } },
    ], as: 'entitlement' } };
  }

  async list(query: MembersQueryDto, today: string, search?: { literal: string; phone?: string }): Promise<Facet<ReadMember>> {
    const pipeline: Document[] = [];
    if (search?.literal) {
      const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pipeline.push({ $match: { $or: [
        { member_code: { $regex: escape(search.literal), $options: 'i' } },
        { full_name: { $regex: escape(search.literal), $options: 'i' } },
        { phone: { $regex: escape(search.phone ?? search.literal), $options: 'i' } },
      ] } });
    }
    pipeline.push({ $sort: { created_at: -1, _id: -1 } },
      { $project: { member_code: 1, full_name: 1, phone: 1, account_id: 1 } });
    if (query.membershipState) {
      pipeline.push(this.entitlement(today));
      const kinds = query.kind ? [query.kind] : ['GYM', 'PT'];
      const scope = { $filter: { input: '$entitlement', as: 'entry', cond: { $in: ['$$entry._id', kinds] } } };
      pipeline.push({ $match: { $expr: query.membershipState === 'NONE'
        ? { $eq: [{ $size: scope }, 0] }
        : { $anyElementTrue: [{ $map: { input: scope, as: 'entry', in: { $in: [query.membershipState, '$$entry.states'] } } }] } } });
    }
    pipeline.push(this.facet(query, query.membershipState ? [] : [this.entitlement(today)]));
    const [result] = await this.connection.collection('members').aggregate<Facet<ReadMember>>(pipeline).toArray();
    return result;
  }

  async detail(id: ObjectId, today: string): Promise<ReadMember | null> {
    const [member] = await this.connection.collection('members').aggregate<ReadMember>([
      { $match: { _id: id } },
      { $project: { member_code: 1, full_name: 1, phone: 1, birth_date: 1, address: 1, account_id: 1,
        version: 1, created_at: 1, updated_at: 1 } }, this.entitlement(today),
    ]).toArray();
    return member ?? null;
  }
  exists(id: ObjectId) {
    return this.connection.collection('members').findOne({ _id: id }, { projection: { _id: 1 } });
  }

  async memberships(id: ObjectId, query: MemberPaginationDto): Promise<Facet<ReadMembership>> {
    const [result] = await this.connection.collection('service_sales').aggregate<Facet<ReadMembership>>([
      { $match: { member_id: id } }, ...this.transactionJoin(),
      { $match: { 'transaction.kind': { $in: ['GYM', 'PT'] } } },
      { $lookup: { from: 'memberships', localField: '_id', foreignField: 'service_sale_id',
        pipeline: [{ $project: { status: 1, sessions_used: 1 } }], as: 'membership' } },
      { $unwind: '$membership' },
      { $project: { _id: '$membership._id', sale_id: '$_id', kind: '$transaction.kind', plan_name: '$plan_name_snapshot',
        start_date: 1, end_date: 1, stored_status: '$membership.status', transaction_status: '$transaction.status',
        sessions_quota: '$sessions_snapshot', sessions_used: '$membership.sessions_used', created_at: '$transaction.created_at' } },
      { $sort: { created_at: -1, _id: -1 } }, this.facet(query),
    ]).toArray();
    return result;
  }

  async transactions(id: ObjectId, query: MemberPaginationDto): Promise<Facet<ReadTransaction>> {
    const [result] = await this.connection.collection('transactions').aggregate<Facet<ReadTransaction>>([
      { $match: { member_id: id } }, { $sort: { created_at: -1, _id: -1 } },
      this.facet(query, [
        { $project: { code: 1, kind: 1, status: 1, amount_due: 1, created_at: 1 } },
        { $lookup: { from: 'payments', localField: '_id', foreignField: 'transaction_id', let: { settled: '$status' },
          pipeline: [{ $match: { status: 'SUCCEEDED', $expr: { $eq: ['$$settled', 'SETTLED'] } } },
            { $project: { _id: 1 } }, { $limit: 1 }], as: 'payments' } },
        { $lookup: { from: 'invoices', localField: '_id', foreignField: 'transaction_id',
          pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }], as: 'invoices' } },
      ]),
    ]).toArray();
    return result;
  }

  private facet(query: MemberPaginationDto, afterPage: Document[] = []): Document {
    return { $facet: { items: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }, ...afterPage],
      count: [{ $count: 'total' }] } };
  }
}
