import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Filter } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock, addCalendarDays, assertBusinessDate } from '../../common/utils/business-date';
import { validateObjectId } from '../../common/utils/normalization';
import { fromVndDecimal, toVndDecimal } from '../../common/utils/vnd-money';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { Payment } from '../payments/schemas/payment.schema';
import { Refund } from './refund.schema';
import { RefundQueryDto } from './refunds.dto';
import { RefundAttempt } from './refund-attempt.schema';

const inconsistent = () => new ApplicationError(409, 'REFUND_INTEGRITY_ERROR', 'Nghĩa vụ hoàn cần được đối chiếu với khoản thu gốc');
@Injectable()
export class RefundsService {
  constructor(@InjectConnection() private readonly connection: Connection, @InjectModel('Refund') readonly refunds: Model<Refund>,
    private readonly transactions: TransactionRunner, private readonly clock: ServerClock) {}

  // The caller owns the transaction gate. FAILED remains an outstanding obligation; it is never replaced.
  async cancellation(orderId: Types.ObjectId, payment: Payment, now: Date, actorId: Types.ObjectId | undefined, session: ClientSession) {
    const amount = this.amount(payment.amount);
    if (payment.status !== 'SUCCEEDED') throw inconsistent();
    const rows = await this.connection.db!.collection<Refund>('refunds').find({ payment_id: payment._id }, { session }).toArray();
    let accounted = 0n;
    for (const row of rows) {
      const value = this.amount(row.amount);
      if (!(row.id instanceof Types.ObjectId) || !row.id.equals(row._id) || !(row.order_id instanceof Types.ObjectId) || !row.order_id.equals(orderId) ||
        !['PENDING', 'FAILED', 'SUCCEEDED'].includes(row.status) || !row.obligation_key || !row.reference ||
        (row.status === 'SUCCEEDED' ? !Number.isFinite(row.refunded_at?.getTime()) : row.refunded_at !== undefined)) throw inconsistent();
      accounted += value;
    }
    if (accounted > amount) throw inconsistent();
    const key = `CANCELLATION:${payment._id}`, existing = rows.find(row => row.obligation_key === key);
    if (existing) {
      if (existing.reason !== 'CANCELLATION' || existing.reference !== `RF:${existing._id}`) throw inconsistent();
      if (accounted !== amount) throw inconsistent();
      return existing;
    }
    if (accounted === amount) return null;
    const id = new Types.ObjectId();
    const [created] = await this.refunds.create([{ _id: id, id, order_id: orderId, payment_id: payment._id, reason: 'CANCELLATION',
      reference: `RF:${id}`, obligation_key: key, amount: toVndDecimal(String(amount - accounted)), status: 'PENDING',
      created_at: now, actor_type: actorId ? 'USER' : 'SYSTEM', ...(actorId ? { created_by: actorId } : {}) }], { session });
    return created.toObject();
  }
  private amount(value: Types.Decimal128): bigint {
    try {
      if (value?._bsontype !== 'Decimal128') throw inconsistent();
      const amount = BigInt(fromVndDecimal(value));
      if (amount <= 0n) throw inconsistent();
      return amount;
    } catch { throw inconsistent(); }
  }
  async list(query: RefundQueryDto) {
    const to = assertBusinessDate(query.toDate ?? this.clock.today()), from = assertBusinessDate(query.fromDate ?? addCalendarDays(to, -29));
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 366) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Khoảng ngày phải từ 1 đến 366 ngày');
    const filter: Filter<Refund> = { created_at: { $gte: new Date(`${from}T00:00:00+07:00`), $lt: new Date(`${addCalendarDays(to, 1)}T00:00:00+07:00`) } };
    if (query.orderId) filter.order_id = new Types.ObjectId(validateObjectId(query.orderId));
    if (query.status) filter.status = query.status;
    return this.transactions.run(async session => {
      const collection = this.connection.db!.collection<Refund>('refunds');
      const total = await collection.countDocuments(filter, { session });
      const rows = await collection.find(filter, { session }).sort({ created_at: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).toArray();
      const items = [];
      for (const row of rows) items.push({ ...this.map(row), attemptCount: await this.connection.db!.collection('refund_attempts').countDocuments({ refund_id: row._id }, { session }) });
      return { items, page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit), asOf: this.clock.now().toISOString() };
    });
  }
  async detail(id: string) {
    const target = new Types.ObjectId(validateObjectId(id));
    return this.transactions.run(async session => {
      const row = await this.connection.db!.collection<Refund>('refunds').findOne({ _id: target }, { session });
      if (!row) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy nghĩa vụ hoàn');
      const payment = await this.connection.db!.collection<Payment>('payments').findOne({ _id: row.payment_id }, { session });
      const order = await this.connection.db!.collection('orders').findOne({ _id: row.order_id }, { session });
      const attempts = await this.connection.db!.collection<RefundAttempt>('refund_attempts').find({ refund_id: row._id }, { session }).sort({ occurred_at: -1, _id: -1 }).toArray();
      return { ...this.map(row), createdBy: row.created_by ? String(row.created_by) : null, actorType: row.actor_type,
        obligationKey: row.obligation_key, payoutEvidence: row.payout_evidence ?? null, failureReason: row.failure_code ?? null,
        verifiedBy: row.verified_by ? String(row.verified_by) : null, verifiedAt: row.verified_at?.toISOString() ?? null,
        attempts: attempts.map(attempt => ({ id: String(attempt._id), statusBefore: attempt.status_before, statusAfter: attempt.status_after,
          actorId: String(attempt.actor_id), occurredAt: attempt.occurred_at.toISOString(), evidenceNote: attempt.evidence_note,
          failureReason: attempt.failure_reason ?? null, method: attempt.method ?? null, payoutEvidence: attempt.payout_evidence ?? null, paidOutAt: attempt.paid_out_at?.toISOString() ?? null })), asOf: this.clock.now().toISOString(),
        orderCode: order?.code ?? null, cancellationReason: order?.cancellation_reason ?? null, cancelledAt: order?.cancelled_at?.toISOString() ?? null,
        payment: payment ? { id: String(payment._id), transactionId: String(payment.transaction_id), method: payment.method,
          amount: fromVndDecimal(payment.amount), status: payment.status, reference: payment.reference, receiptPurpose: payment.receipt_purpose ?? 'ORDER_SETTLEMENT',
          paidAt: payment.paid_at?.toISOString() ?? null, verifiedAt: payment.verified_at?.toISOString() ?? null, evidenceNote: payment.evidence_note ?? null } : null };
    });
  }
  private map(row: Refund) {
    return { id: String(row._id), orderId: String(row.order_id), paymentId: String(row.payment_id), returnId: row.return_id ? String(row.return_id) : null,
      source: row.reason, reference: row.reference, amount: fromVndDecimal(row.amount), status: row.status, version: row.version ?? 0, method: row.method ?? null,
      refundAmount: fromVndDecimal(row.amount), refundedAmount: row.status === 'SUCCEEDED' ? fromVndDecimal(row.amount) : '0',
      outstandingRefundAmount: row.status === 'SUCCEEDED' ? '0' : fromVndDecimal(row.amount),
      createdAt: row.created_at.toISOString(), refundedAt: row.refunded_at?.toISOString() ?? null };
  }
}
