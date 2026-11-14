import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { addCalendarDays, assertBusinessDate, membershipEndDate, ServerClock } from '../../common/utils/business-date';
import { fromVndDecimal, toVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { MembersRepository } from '../members/members.repository';
import { SaleChannel } from '../memberships/schemas/service-sale.schema';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { PlansReader } from '../plans/plans.reader';
import { ActivationResult, ActivationTarget, invalidState } from './sale-activation.contract';
import { RenewalDto } from './renewals.dto';
import { RenewalsRepository } from './renewals.repository';
import { SaleReader } from './sale-reader.service';
import { SalesRepository } from './sales.repository';
import { ZeroSettlement } from './zero-settlement.service';

@Injectable()
export class RenewalService {
  constructor(private readonly repository: SalesRepository, private readonly renewals: RenewalsRepository,
    private readonly members: MembersRepository, private readonly plans: PlansReader,
    private readonly commands: IdempotencyService, private readonly guards: DataGuardsService,
    private readonly clock: ServerClock, private readonly transactions: TransactionRunner,
    private readonly reader: SaleReader, private readonly zero: ZeroSettlement) {}

  private normalize(input: RenewalDto) {
    if (!Number.isSafeInteger(input.planVersion) || input.planVersion < 0) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Phiên bản gói không hợp lệ');
    return { memberId: idOf(input.memberId).toHexString(), previousSaleId: idOf(input.previousSaleId).toHexString(), planVersion: input.planVersion };
  }

  private async source(memberId: Types.ObjectId, previousSaleId: Types.ObjectId, session: ClientSession) {
    const source = await this.renewals.source(memberId, previousSaleId, session);
    if (!source) throw new ApplicationError(404, 'SALE_NOT_FOUND', 'Không tìm thấy kỳ gói của hội viên');
    const { sale, transaction, membership } = source;
    if (!transaction || transaction.status !== 'SETTLED' || !membership || membership.status !== 'ACTIVE' ||
      !['GYM', 'PT'].includes(transaction.kind) || (sale.kind_snapshot && sale.kind_snapshot !== transaction.kind)) {
      throw conflict('SOURCE_NOT_ELIGIBLE', 'Kỳ nguồn chưa được cấp hoặc không còn đủ điều kiện gia hạn');
    }
    const kind = transaction.kind as 'GYM' | 'PT';
    if (!await this.renewals.isLatest(memberId, kind, previousSaleId, session)) {
      throw conflict('SOURCE_NOT_LATEST', 'Kỳ nguồn không còn là kỳ mới nhất. Hãy tải lại và xác nhận lựa chọn');
    }
    assertBusinessDate(sale.end_date);
    return { sale, kind };
  }

  private async terms(input: RenewalDto, session: ClientSession) {
    const memberId = idOf(input.memberId);
    if (!await this.members.findById(memberId, session)) throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hội viên');
    const source = await this.source(memberId, idOf(input.previousSaleId), session);
    const plan = await this.plans.findById(source.sale.plan_id.toHexString(), session);
    if (!plan || plan.status !== 'ACTIVE' || plan.kind !== source.kind) throw conflict('PLAN_NOT_AVAILABLE', 'Gói nguồn hiện không được bán để gia hạn');
    if (plan.version !== input.planVersion) throw conflict('PLAN_CHANGED', 'Điều khoản gói đã thay đổi. Hãy tải lại và xác nhận');
    const startDate = renewalStart(source.sale.end_date, this.clock.today());
    const endDate = membershipEndDate(startDate, plan.duration_days);
    const blockingCode = await this.renewals.pending(memberId, source.kind, session) ? 'PENDING_SALE_EXISTS' : undefined;
    return { ...source, plan, startDate, endDate, blockingCode };
  }

  preview(dto: RenewalDto) {
    const input = this.normalize(dto);
    return this.transactions.run(async session => {
      const terms = await this.terms(input, session);
      return { previousSaleId: input.previousSaleId, sourceEndDate: terms.sale.end_date,
        amountDue: fromVndDecimal(terms.plan.price), expectedStartDate: terms.startDate, expectedEndDate: terms.endDate,
        planVersion: terms.plan.version, asOf: this.clock.now().toISOString(), canProceed: !terms.blockingCode,
        ...(terms.blockingCode ? { blockingCode: terms.blockingCode } : {}) };
    });
  }

  // US-19 adds its ownership adapter around this same method; channel is a server argument, never public DTO input.
  create(actorId: string, dto: RenewalDto, key: string, channel: SaleChannel = 'COUNTER') {
    const input = this.normalize(dto);
    const actor = idOf(actorId).toHexString();
    return this.commands.execute({ actorId: actor, operation: 'SALE_RENEW', clientKey: key, payload: { ...input, actorId: actor, channel } }, async session => {
      const source = await this.renewals.source(idOf(input.memberId), idOf(input.previousSaleId), session);
      if (!source) throw new ApplicationError(404, 'SALE_NOT_FOUND', 'Không tìm thấy kỳ gói của hội viên');
      if (!await this.members.findById(idOf(input.memberId), session)) throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hội viên');
      if (!await this.plans.findById(source.sale.plan_id.toHexString(), session)) throw conflict('PLAN_NOT_AVAILABLE', 'Gói nguồn không còn được bán');
      await this.guards.acquire(session, { plans: [source.sale.plan_id], members: [idOf(input.memberId)] });
      const terms = await this.terms(input, session);
      if (terms.blockingCode) throw conflict(terms.blockingCode, 'Hội viên đã có giao dịch chờ cùng loại');
      const saleId = new Types.ObjectId(), transactionId = new Types.ObjectId();
      const now = this.clock.now();
      const plan = terms.plan;
      await this.repository.transactions.create([{ _id: transactionId, id: transactionId, member_id: input.memberId,
        created_by: actor, code: `TX-${transactionId.toHexString()}`, kind: terms.kind, amount_due: plan.price,
        status: 'PENDING', request_key: transactionRequestKey(actor, 'SALE_RENEW', key), created_at: now, version: 0, guard_revision: 0n }], { session });
      await this.repository.sales.create([{ _id: saleId, id: saleId, transaction_id: transactionId, member_id: input.memberId,
        plan_id: plan._id, operation: 'RENEW', previous_sale_id: input.previousSaleId, channel,
        requested_start_date: terms.startDate, start_date: terms.startDate, end_date: terms.endDate,
        duration_days_snapshot: plan.duration_days, kind_snapshot: terms.kind, plan_version_snapshot: plan.version,
        plan_name_snapshot: plan.name, benefits_snapshot: plan.benefits, list_price_snapshot: plan.price,
        credit_amount: toVndDecimal('0'), sessions_snapshot: plan.session_quota, created_at: now,
        policy_snapshot: JSON.stringify({ rule: 'RENEW_V1', timeZone: 'Asia/Ho_Chi_Minh', dayInclusive: true,
          activationStartRule: 'MAX_SOURCE_END_PLUS_ONE_SERVER_CONFIRMATION_DATE', durationDays: plan.duration_days }) }], { session });
      if (fromVndDecimal(plan.price) === '0') {
        const target = { saleId, transactionId, memberId: idOf(input.memberId) };
        await this.zero.completeZeroWithinSession(session, target, actor, () => this.activateWithinSession(session, target));
      }
      return { status: 201, body: await this.reader.detail(saleId.toHexString(), session), resultIds: { saleId, transactionId } };
    });
  }

  // Caller holds plan -> member (new zero sale), or member -> transaction (paid settlement), in this session.
  // Use only frozen sale terms here; never acquire a live plan lock after the member lock.
  async activateWithinSession(session: ClientSession, target: ActivationTarget): Promise<ActivationResult> {
    if (!session.inTransaction()) throw new Error('SALE_TRANSACTION_REQUIRED');
    const sale = await this.repository.sales.findOne({ _id: target.saleId, member_id: target.memberId, transaction_id: target.transactionId })
      .session(session).lean().exec();
    const transaction = await this.repository.transactions.findById(target.transactionId).session(session).lean().exec();
    if (!sale || sale.operation !== 'RENEW' || !sale.previous_sale_id || !sale.duration_days_snapshot || !sale.kind_snapshot ||
      !transaction || transaction.status !== 'PENDING' || !transaction.member_id?.equals(target.memberId) || transaction.kind !== sale.kind_snapshot ||
      fromVndDecimal(sale.credit_amount) !== '0' || fromVndDecimal(sale.list_price_snapshot) !== fromVndDecimal(transaction.amount_due) ||
      policyRule(sale.policy_snapshot) !== 'RENEW_V1') throw invalidState();
    const source = await this.source(target.memberId, sale.previous_sale_id, session);
    if (source.kind !== sale.kind_snapshot || !source.sale.plan_id.equals(sale.plan_id)) throw conflict('SOURCE_NOT_ELIGIBLE', 'Kỳ nguồn không khớp gói gia hạn');
    if (await this.renewals.pending(target.memberId, source.kind, session, target.transactionId)) throw conflict('PENDING_SALE_EXISTS', 'Đã có giao dịch chờ cùng loại khác');
    if (await this.repository.memberships.exists({ service_sale_id: sale._id }).session(session)) throw invalidState();
    if (fromVndDecimal(transaction.amount_due) !== '0') {
      const payment = await this.repository.payments.findOne({ transaction_id: transaction._id, status: 'SUCCEEDED' }).session(session).lean().exec();
      if (!payment || fromVndDecimal(payment.amount) !== fromVndDecimal(transaction.amount_due)) throw invalidState();
    }
    const startDate = renewalStart(source.sale.end_date, this.clock.today());
    const endDate = membershipEndDate(startDate, sale.duration_days_snapshot);
    await this.repository.sales.updateOne({ _id: sale._id }, { $set: { start_date: startDate, end_date: endDate } }, { session, runValidators: true });
    const id = new Types.ObjectId();
    await this.repository.memberships.create([{ _id: id, id, service_sale_id: sale._id, status: 'ACTIVE', sessions_used: 0,
      created_at: this.clock.now(), version: 0 }], { session });
    return { membershipId: id.toHexString(), startDate, endDate };
  }
}

function idOf(value: string) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new ApplicationError(400, 'VALIDATION_ERROR', 'ID phải là ObjectId hợp lệ');
  return new Types.ObjectId(value);
}
function renewalStart(sourceEnd: string, today: string) { return sourceEnd >= today ? addCalendarDays(sourceEnd, 1) : today; }
function conflict(code: string, message: string) { return new ApplicationError(409, code, message); }
function policyRule(snapshot: string): unknown {
  try { return (JSON.parse(snapshot) as { rule?: unknown } | null)?.rule; } catch { return undefined; }
}
