import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Document, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';

export interface ReportMemberSource {
  _id: ObjectId; member_code?: string; full_name?: string; account_id?: ObjectId; created_at?: Date;
}
export interface ReportSaleSource {
  _id: ObjectId; member_id?: ObjectId; transaction_id?: ObjectId; plan_id?: ObjectId;
  plan_name_snapshot?: string; kind_snapshot?: string; start_date?: string; end_date?: string; created_at?: Date;
}
export interface ReportMembershipSource {
  _id: ObjectId; service_sale_id?: ObjectId; status?: string; created_at?: Date;
  superseded_at?: Date; superseded_by_membership_id?: ObjectId; cancelled_at?: Date;
}
export interface ReportTransactionSource {
  _id: ObjectId; member_id?: ObjectId; kind?: string; status?: string; settled_at?: Date;
}
export interface MembershipReportSources {
  members: ReportMemberSource[]; sales: ReportSaleSource[];
  memberships: ReportMembershipSource[]; transactions: ReportTransactionSource[];
}

@Injectable()
export class MembershipReportsRepository {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  members(session: ClientSession): Promise<ReportMemberSource[]> {
    return this.connection.db!.collection<ReportMemberSource>('members').find({}, { session, maxTimeMS: 5000,
      projection: { _id: 1, member_code: 1, full_name: 1, account_id: 1, created_at: 1 } }).toArray();
  }

  // Small-project source projection, one primary snapshot. Never read accounts, payments,
  // invoices or live plans; these joins would multiply rows or change historical meaning.
  async sources(session: ClientSession): Promise<MembershipReportSources> {
    const read = <T extends Document>(name: string, projection: Document) => this.connection.db!.collection<T>(name)
      .find({}, { session, projection, maxTimeMS: 5000 }).toArray();
    const members = await this.members(session);
    const sales = await read<ReportSaleSource>('service_sales', { _id: 1, member_id: 1, transaction_id: 1, plan_id: 1,
      plan_name_snapshot: 1, kind_snapshot: 1, start_date: 1, end_date: 1, created_at: 1 });
    const memberships = await read<ReportMembershipSource>('memberships', { _id: 1, service_sale_id: 1, status: 1, created_at: 1,
      superseded_at: 1, superseded_by_membership_id: 1, cancelled_at: 1 });
    const transactions = await read<ReportTransactionSource>('transactions', { _id: 1, member_id: 1, kind: 1, status: 1, settled_at: 1 });
    return { members, sales, memberships, transactions };
  }
}
