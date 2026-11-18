import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Document, ObjectId } from 'mongodb';
import { Connection } from 'mongoose';

// Unknown fields deliberately remain unknown: legacy corruption must never become a zero.
export interface CashSource extends Document {
  _id: ObjectId; transaction_id?: ObjectId; payment_id?: ObjectId; order_id?: ObjectId; return_id?: ObjectId;
  amount?: unknown; paid_at?: unknown; refunded_at?: unknown; status?: string; method?: string;
  kind?: string; code?: string; invoice_no?: string; reference?: string; receipt_purpose?: string;
}
export interface CashFlowSources { payments: CashSource[]; refunds: CashSource[]; transactions: CashSource[]; orders: CashSource[]; invoices: CashSource[] }

@Injectable()
export class CashFlowRepository {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async snapshot<T>(read: (session: ClientSession) => Promise<T>): Promise<T> {
    // Read-only snapshot sessions pin atClusterTime on the first read (MongoDB >=5).
    // This needs no write transaction and keeps subsequent getMore/source reads on that snapshot.
    const session = await this.connection.startSession({ snapshot: true });
    try { return await read(session); } finally { await session.endSession(); }
  }

  receipts(session: ClientSession) {
    return this.connection.db!.collection<CashSource>('payments').find({ status: 'SUCCEEDED' }, { session, readPreference: 'primary', timeoutMS: 5000,
      projection: { _id: 1, transaction_id: 1, amount: 1, status: 1, method: 1, paid_at: 1, receipt_purpose: 1 } }).toArray();
  }
  async sources(session: ClientSession): Promise<CashFlowSources> {
    // Sequential reads on the SAME primary snapshot. Each _id is read once, no unwind of items/attempts.
    // Include undated sources so corrupt SUCCEEDED records cannot disappear behind a date predicate.
    // Explicit cursor CSOT covers every getMore batch, not just the first batch.
    const payments = await this.receipts(session);
    const read = (name: string, projection: Document, filter: Document = {}) => this.connection.db!.collection<CashSource>(name)
      .find(filter, { session, projection, readPreference: 'primary', timeoutMS: 5000 }).toArray();
    const refunds = await read('refunds', { _id: 1, payment_id: 1, order_id: 1, return_id: 1, reference: 1,
      amount: 1, status: 1, method: 1, refunded_at: 1 }, { status: { $in: ['SUCCEEDED', 'PENDING', 'FAILED'] } });
    const transactions = await read('transactions', { _id: 1, kind: 1, code: 1, status: 1 });
    const orders = await read('orders', { _id: 1, transaction_id: 1, code: 1 });
    const invoices = await read('invoices', { _id: 1, transaction_id: 1, invoice_no: 1 });
    return { payments, refunds, transactions, orders, invoices };
  }
}
