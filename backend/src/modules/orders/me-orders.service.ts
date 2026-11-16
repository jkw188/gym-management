import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { validateObjectId } from '../../common/utils/normalization';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { OrdersRepository } from './orders.repository';
import { Order } from './order.schema';

// Minimal US-45 adapter for persisted orders; checkout/quote remain owned by US-41/42.
@Injectable()
export class MeOrdersService {
  constructor(private readonly repository: OrdersRepository, private readonly transactions: TransactionRunner, private readonly clock: ServerClock) {}
  list(actorId: string, query: { status?: string; page: number; limit: number }) {
    return this.transactions.run(async session => {
      const member = await this.repository.connection.db!.collection('members').findOne({ account_id: new Types.ObjectId(actorId) }, { session, projection: { _id: 1 } });
      if (!member) return { items: [], memberLinked: false, page: query.page, limit: query.limit, total: 0, totalPages: 0 };
      const page = await this.repository.page({ member_id: member._id, ...(query.status ? { status: query.status as Order['status'] } : {}) }, undefined, query.page, query.limit, session);
      const items = [];
      for (const row of page.items) items.push(await this.map(row, session));
      return { ...page, items, memberLinked: true };
    });
  }
  detail(actorId: string, id: string) {
    const target = new Types.ObjectId(validateObjectId(id));
    return this.transactions.run(async session => {
      await this.repository.assertOwner(actorId, target, session);
      const row = await this.repository.order(target, session);
      if (!row) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng');
      return this.map(row, session);
    });
  }
  private async map(row: Order, session: ClientSession) {
    const transaction = await this.repository.transaction(row.transaction_id, session), refunds = await this.repository.refunds(row._id, session), now = this.clock.now();
    return { id: String(row._id), code: row.code, channel: row.channel, status: row.status, version: row.version, reservationState: row.reservation_state,
      reservationExpiresAt: row.reservation_expires_at.toISOString(), expired: now >= row.reservation_expires_at, asOf: now.toISOString(),
      total: transaction ? fromVndDecimal(transaction.amount_due) : null, transactionStatus: transaction?.status ?? null,
      cancelledAt: row.cancelled_at?.toISOString() ?? null, cancellationReason: row.cancellation_reason ?? null,
      items: (await this.repository.lines(row._id, session)).map(item => ({ id: String(item._id), name: item.name_snapshot, quantity: item.quantity, lineTotal: fromVndDecimal(item.line_total) })),
      refunds: refunds.map(refund => ({ id: String(refund._id), status: refund.status, amount: fromVndDecimal(refund.amount) })) };
  }
}
