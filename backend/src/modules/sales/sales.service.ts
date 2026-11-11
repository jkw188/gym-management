import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock, assertBusinessDate, membershipEndDate } from '../../common/utils/business-date';
import { fromVndDecimal, toVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { MembersRepository } from '../members/members.repository';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { RegisterSaleDto, CancelSaleDto } from './sales.dto';
import { SalesRepository } from './sales.repository';
import { SaleActivationService, invalidState } from './sale-activation.service';
import { ZeroSettlement } from './zero-settlement.service';
import { PlansReader } from '../plans/plans.reader';

@Injectable()
export class SalesService {
  constructor(private readonly repository: SalesRepository, private readonly members: MembersRepository,
    private readonly commands: IdempotencyService, private readonly guards: DataGuardsService,
    private readonly clock: ServerClock, private readonly activation: SaleActivationService,
    private readonly settlement: ZeroSettlement, private readonly transactions: TransactionRunner, private readonly plans: PlansReader) {}

  async catalog() {
    const plans = await this.plans.activeCatalog();
    return { items: plans.map(plan => ({ id: plan._id.toHexString(), name: plan.name, kind: plan.kind,
      planVersion: plan.version, durationDays: plan.duration_days, sessions: plan.session_quota,
      price: fromVndDecimal(plan.price), benefits: plan.benefits })) };
  }

  async pending(memberId: string, page: number) {
    const id = objectId(memberId);
    if (!await this.members.findById(id)) throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hội viên');
    return this.repository.pending(id, page);
  }

  private normalize(input: RegisterSaleDto) {
    return { memberId: objectId(input.memberId).toHexString(), planId: objectId(input.planId).toHexString(),
      planVersion: input.planVersion, startDate: assertBusinessDate(input.startDate) };
  }

  private async terms(input: RegisterSaleDto, session?: ClientSession) {
    if (input.startDate < this.clock.today()) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Ngày bắt đầu không được trước hôm nay tại Việt Nam');
    const memberId = objectId(input.memberId);
    if (!await this.members.findById(memberId, session)) throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hội viên');
    const plan = await this.plans.findById(input.planId, session);
    if (!plan) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'Không tìm thấy gói');
    if (plan.status !== 'ACTIVE') throw new ApplicationError(409, 'PLAN_NOT_AVAILABLE', 'Gói hiện không được bán');
    if (plan.version !== input.planVersion) throw new ApplicationError(409, 'PLAN_CHANGED', 'Điều khoản gói đã thay đổi. Hãy tải lại và xác nhận');
    const expectedEndDate = membershipEndDate(input.startDate, plan.duration_days);
    const blockingCode = await this.repository.blockingCode(memberId, plan.kind, this.clock.today(), session);
    return { plan, expectedEndDate, blockingCode };
  }

  async preview(dto: RegisterSaleDto) {
    const input = this.normalize(dto);
    const { plan, expectedEndDate, blockingCode } = await this.terms(input);
    return { planVersion: plan.version, amountDue: fromVndDecimal(plan.price), kind: plan.kind,
      requestedStartDate: input.startDate, expectedEndDate, canProceed: !blockingCode, ...(blockingCode ? { blockingCode } : {}) };
  }

  create(actorId: string, dto: RegisterSaleDto, key: string) {
    const input = this.normalize(dto);
    return this.commands.execute({ actorId, operation: 'SALE_REGISTER', clientKey: key, payload: input }, async session => {
      // Check existence for a precise 404 before acquiring revisions; all business checks repeat under locks.
      if (!await this.members.findById(objectId(input.memberId), session)) throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hội viên');
      if (!await this.plans.findById(input.planId, session)) throw new ApplicationError(404, 'PLAN_NOT_FOUND', 'Không tìm thấy gói');
      await this.guards.acquire(session, { plans: [objectId(input.planId)], members: [objectId(input.memberId)] });
      const { plan, expectedEndDate, blockingCode } = await this.terms(input, session);
      if (blockingCode) throw new ApplicationError(409, blockingCode, 'Hội viên đã có gói hoặc giao dịch chờ cùng loại');
      const transactionId = new Types.ObjectId(); const saleId = new Types.ObjectId();
      const amountDue = fromVndDecimal(plan.price);
      await this.repository.transactions.create([{ _id: transactionId, id: transactionId, member_id: input.memberId,
        created_by: actorId, code: `TX-${transactionId.toHexString()}`, kind: plan.kind, amount_due: plan.price,
        status: 'PENDING', request_key: transactionRequestKey(actorId, 'SALE_REGISTER', key),
        created_at: this.clock.now(), version: 0, guard_revision: 0n }], { session });
      await this.repository.sales.create([{ _id: saleId, id: saleId, transaction_id: transactionId, member_id: input.memberId,
        plan_id: plan._id, operation: 'REGISTER', start_date: input.startDate, end_date: expectedEndDate,
        requested_start_date: input.startDate, duration_days_snapshot: plan.duration_days, kind_snapshot: plan.kind,
        plan_version_snapshot: plan.version, created_at: this.clock.now(), plan_name_snapshot: plan.name,
        benefits_snapshot: plan.benefits, list_price_snapshot: plan.price, credit_amount: toVndDecimal('0'),
        sessions_snapshot: plan.session_quota, policy_snapshot: JSON.stringify({ rule: 'REGISTER_V1', timeZone: 'Asia/Ho_Chi_Minh',
          dayInclusive: true, activationStartRule: 'MAX_REQUESTED_SERVER_CONFIRMATION_DATE', requestedStart: input.startDate,
          durationDays: plan.duration_days }) }], { session });
      if (amountDue === '0') {
        const target = { saleId, transactionId, memberId: objectId(input.memberId) };
        await this.settlement.completeZeroWithinSession(session, target, actorId,
          () => this.activation.activateNewFreeSaleWithinSession(session, target));
      }
      const body = await this.detail(saleId.toHexString(), session);
      return { status: 201, body, resultIds: { saleId, transactionId } };
    });
  }

  async detail(id: string, session?: ClientSession): Promise<Record<string, unknown>> {
    objectId(id);
    // Read the sale dates and settlement state from one snapshot, even while a confirmation commits.
    if (!session) return this.transactions.run(current => this.detail(id, current));
    const sale = await this.repository.sales.findById(objectId(id)).session(session ?? null).lean().exec();
    if (!sale) throw new ApplicationError(404, 'SALE_NOT_FOUND', 'Không tìm thấy lần bán gói');
    const transaction = await this.repository.transactions.findById(sale.transaction_id).session(session ?? null).lean().exec();
    if (!transaction) throw new ApplicationError(503, 'SALE_DATA_NOT_READY', 'Dữ liệu giao dịch chưa đầy đủ');
    const membership = await this.repository.memberships.findOne({ service_sale_id: sale._id }).session(session ?? null).lean().exec();
    const invoice = await this.repository.invoices.findOne({ transaction_id: transaction._id }).session(session ?? null).lean().exec();
    const payment = await this.repository.payments.findOne({ transaction_id: transaction._id, status: 'SUCCEEDED' }).session(session ?? null).lean().exec();
    // Notification recipient state is captured at settlement, never recomputed from today's member link.
    const notificationState = await this.repository.notificationState(id.toLowerCase(), session);
    return { saleId: sale._id.toHexString(), memberId: sale.member_id.toHexString(), planId: sale.plan_id.toHexString(),
      transactionId: transaction._id.toHexString(), transactionCode: transaction.code, transactionStatus: transaction.status,
      transactionVersion: transaction.version ?? 0, amountDue: fromVndDecimal(transaction.amount_due),
      kind: sale.kind_snapshot ?? transaction.kind, operation: sale.operation, planName: sale.plan_name_snapshot,
      benefits: sale.benefits_snapshot, sessions: sale.sessions_snapshot, listPrice: fromVndDecimal(sale.list_price_snapshot),
      creditAmount: fromVndDecimal(sale.credit_amount), policySnapshot: sale.policy_snapshot,
      requestedStartDate: sale.requested_start_date ?? sale.start_date, startDate: sale.start_date, endDate: sale.end_date,
      ...(sale.duration_days_snapshot === undefined ? {} : { durationDays: sale.duration_days_snapshot }),
      ...(sale.plan_version_snapshot === undefined ? {} : { planVersion: sale.plan_version_snapshot }),
      ...(membership ? { membershipId: membership._id.toHexString() } : {}),
      ...(invoice ? { invoiceId: invoice._id.toHexString(), invoiceNumber: invoice.invoice_no } : {}),
      ...(payment ? { paymentId: payment._id.toHexString() } : {}),
      notificationState,
      ...(transaction.cancel_reason ? { cancelReason: transaction.cancel_reason } : {}) };
  }

  cancel(actorId: string, id: string, dto: CancelSaleDto, key: string) {
    const saleId = objectId(id);
    return this.commands.execute({ actorId, operation: 'SALE_CANCEL', clientKey: key,
      targetId: saleId.toHexString(), payload: { version: dto.version, reason: dto.reason.trim() } }, async session => {
      const sale = await this.repository.sales.findById(saleId).session(session).lean().exec();
      if (!sale) throw new ApplicationError(404, 'SALE_NOT_FOUND', 'Không tìm thấy lần bán gói');
      await this.guards.acquire(session, { members: [sale.member_id], transactions: [sale.transaction_id] });
      const transaction = await this.repository.transactions.findById(sale.transaction_id).session(session).lean().exec();
      if (!transaction || transaction.status !== 'PENDING') throw invalidState();
      if ((transaction.version ?? 0) !== dto.version) throw new ApplicationError(409, 'VERSION_CONFLICT', 'Giao dịch đã thay đổi. Hãy tải lại');
      if (await this.repository.payments.exists({ transaction_id: transaction._id, status: 'SUCCEEDED' }).session(session)) throw invalidState();
      const changed = await this.repository.transactions.updateOne({ _id: transaction._id, status: 'PENDING', version: dto.version },
        { $set: { status: 'CANCELLED', cancelled_at: this.clock.now(), cancelled_by: objectId(actorId), cancel_reason: dto.reason.trim() },
          $inc: { version: 1 } }, { session, runValidators: true });
      if (changed.modifiedCount !== 1) throw new ApplicationError(409, 'VERSION_CONFLICT', 'Giao dịch đã thay đổi. Hãy tải lại');
      return { status: 200, body: { saleId: id.toLowerCase(), transactionId: transaction._id.toHexString(), status: 'CANCELLED' },
        resultIds: { saleId, transactionId: transaction._id } };
    });
  }
}

function objectId(value: string) {
  if (!/^[a-f\d]{24}$/i.test(value)) throw new ApplicationError(400, 'VALIDATION_ERROR', 'ID phải là ObjectId hợp lệ');
  return new Types.ObjectId(value);
}
