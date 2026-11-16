import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Filter } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { Transaction } from '../payments/schemas/transaction.schema';
import { Invoice } from '../payments/schemas/invoice.schema';
import { Payment } from '../payments/schemas/payment.schema';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { orderIntegrityError } from './order.policy';
import { OperationRequestSchema } from '../operations/schemas/operation-request.schema';
import { NotificationSchema } from '../notifications/schemas/notification.schema';
import { NotificationRecipientSchema } from '../notifications/schemas/notification-recipient.schema';
import { NotificationOutboxSchema } from '../notifications/schemas/notification-outbox.schema';
import { Order, OrderEvent, OrderItem, ORDER_MODELS } from './order.schema';

@Injectable()
export class OrdersRepository {
  constructor(@InjectConnection() readonly connection: Connection,
    @InjectModel('Order') readonly orders: Model<Order>, @InjectModel('OrderEvent') readonly events: Model<OrderEvent>) {}
  order(id: Types.ObjectId, session: ClientSession) { return this.connection.db!.collection<Order>('orders').findOne({ _id: id }, { session }); }
  transaction(id: Types.ObjectId, session: ClientSession) { return this.connection.db!.collection<Transaction>('transactions').findOne({ _id: id }, { session }); }
  lines(id: Types.ObjectId, session: ClientSession) { return this.connection.db!.collection<OrderItem>('order_items').find({ order_id: id }, { session }).sort({ _id: 1 }).toArray(); }
  async recipient(memberId: Types.ObjectId | undefined, session: ClientSession) {
    if (!memberId) return [];
    const member = await this.connection.db!.collection<{ _id: Types.ObjectId; account_id?: Types.ObjectId }>('members').findOne({ _id: memberId }, { session, projection: { account_id: 1 } });
    if (!member) throw new ApplicationError(409, 'ORDER_INTEGRITY_ERROR', 'Không tìm thấy hội viên của đơn hàng');
    return member.account_id ? [String(member.account_id)] : [];
  }
  async page(filter: Filter<Order>, transactionStatus: string | undefined, page: number, limit: number, session: ClientSession) {
    const pipeline = [{ $match: filter }, { $lookup: { from: 'transactions', localField: 'transaction_id', foreignField: '_id', as: 'transaction' } },
      ...(transactionStatus ? [{ $match: { 'transaction.status': transactionStatus } }] : [])];
    // A single snapshot covers both count and page, including joined transaction state.
    const [result] = await this.connection.db!.collection<Order>('orders').aggregate<{ items: Order[]; count: { total: number }[] }>([
      ...pipeline, { $facet: { items: [{ $sort: { created_at: -1, _id: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }, { $unset: 'transaction' }], count: [{ $count: 'total' }] } },
    ], { session }).toArray();
    const total = result.count[0]?.total ?? 0;
    return { items: result.items, page, limit, total, totalPages: Math.ceil(total / limit) };
  }
  invoice(transactionId: Types.ObjectId, session: ClientSession) {
    return this.connection.db!.collection<Invoice>('invoices').findOne({ transaction_id: transactionId }, { session,
      projection: { _id: 1, invoice_no: 1, total_amount: 1, issued_at: 1 } });
  }
  refunds(orderId: Types.ObjectId, session: ClientSession) {
    return this.connection.db!.collection<{ _id: Types.ObjectId; order_id: Types.ObjectId; amount: Types.Decimal128; status: string }>('refunds')
      .find({ order_id: orderId }, { session, projection: { _id: 1, amount: 1, status: 1 } }).sort({ _id: 1 }).toArray();
  }
  async assertPaymentIntegrity(transaction: Transaction, session: ClientSession) {
    if (!['PENDING', 'SETTLED'].includes(transaction.status)) return;
    try {
      const payments = await this.connection.db!.collection<Payment>('payments').find({ transaction_id: transaction._id, status: 'SUCCEEDED' }, { session }).toArray();
      const invoice = await this.invoice(transaction._id, session), due = fromVndDecimal(transaction.amount_due);
      if (transaction.status === 'PENDING') {
        if (due === '0' || payments.length || invoice) throw orderIntegrityError();
      } else if (!transaction.settled_at || !invoice || fromVndDecimal(invoice.total_amount) !== due ||
        (due === '0' ? payments.length !== 0 : payments.length !== 1 || fromVndDecimal(payments[0].amount) !== due || !payments[0].verified_by || !payments[0].paid_at)) throw orderIntegrityError();
    } catch { throw orderIntegrityError(); }
  }
  async assertWriterReady() {
    const schemas = [...ORDER_MODELS.map(model => model.schema), OperationRequestSchema, NotificationSchema, NotificationRecipientSchema, NotificationOutboxSchema];
    for (const schema of schemas) {
      const indexes = await this.connection.db!.collection(schema.get('collection')!).listIndexes().toArray().catch(() => []);
      if (indexes.some(index => index.expireAfterSeconds !== undefined) || schema.indexes().some(([key, options]) => !indexes.some(index =>
        JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === Boolean(options.unique) && !index.sparse &&
        JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression) && (!index.collation || index.collation.locale === 'simple')))) {
        throw new ApplicationError(503, 'ORDERS_NOT_READY', 'Cần chạy npm run ensure-indexes và đối chiếu dữ liệu đơn hàng');
      }
    }
  }
}
