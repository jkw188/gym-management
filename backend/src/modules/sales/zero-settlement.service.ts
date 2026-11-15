import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ServerClock } from '../../common/utils/business-date';
import { fromVndDecimal, toVndDecimal } from '../../common/utils/vnd-money';
import { MembersRepository } from '../members/members.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationState } from '../notifications/notifications.types';
import { ActivationResult, ActivationTarget, invalidState } from './sale-activation.contract';
import { SalesRepository } from './sales.repository';

// Separate completion port: the future US-22 settlement module can implement this without importing SalesModule.
export abstract class ZeroSettlement {
  abstract completeZeroWithinSession(session: ClientSession, target: ActivationTarget, actorId: string,
    activate: () => Promise<ActivationResult>): Promise<ActivationResult & { invoiceId: string; notificationState: NotificationState }>;
}

@Injectable()
export class ZeroSettlementService extends ZeroSettlement {
  constructor(private readonly repository: SalesRepository, private readonly members: MembersRepository,
    private readonly notifications: NotificationsService, private readonly clock: ServerClock) { super(); }

  async completeZeroWithinSession(session: ClientSession, target: ActivationTarget, actorId: string,
    activate: () => Promise<ActivationResult>) {
    const sale = await this.repository.sales.findById(target.saleId).session(session).lean().exec();
    const transaction = await this.repository.transactions.findById(target.transactionId).session(session).lean().exec();
    if (!session.inTransaction() || !sale || !transaction || !['REGISTER', 'RENEW'].includes(sale.operation) ||
      fromVndDecimal(sale.list_price_snapshot) !== '0' || fromVndDecimal(sale.credit_amount) !== '0' ||
      fromVndDecimal(transaction.amount_due) !== '0' || transaction.status !== 'PENDING') throw invalidState();
    const member = await this.members.findById(target.memberId, session);
    if (!member) throw invalidState();
    const activated = await activate();
    const id = new Types.ObjectId();
    await this.repository.invoices.create([{ _id: id, id, transaction_id: target.transactionId,
      invoice_no: `INV-${id.toHexString()}`, issued_at: this.clock.now(), total_amount: toVndDecimal('0'),
      buyer_snapshot: JSON.stringify({ fullName: member.full_name, memberCode: member.member_code, phone: member.phone }) }], { session });
    const changed = await this.repository.transactions.updateOne({ _id: transaction._id, status: 'PENDING', version: transaction.version },
      { $set: { status: 'SETTLED', settled_at: this.clock.now() }, $inc: { version: 1 } }, { session });
    if (changed.modifiedCount !== 1) throw invalidState();
    const event = await this.notifications.persistBusinessEvent(session, {
      eventKey: `SERVICE_SALE_SETTLED:${target.saleId.toHexString()}`, title: sale.operation === 'RENEW' ? 'Gia hạn gói thành công' : 'Đăng ký gói thành công',
      body: `${sale.operation === 'RENEW' ? 'RENEW · ' : ''}Gói ${sale.plan_name_snapshot}: ${activated.startDate} – ${activated.endDate}. Giao dịch ${transaction.code}.`,
      memberId: target.memberId.toHexString(), transactionId: target.transactionId.toHexString(), createdBy: actorId,
    }, member.account_id ? [member.account_id.toHexString()] : []);
    return { ...activated, invoiceId: id.toHexString(), notificationState: event.notificationState };
  }
}
