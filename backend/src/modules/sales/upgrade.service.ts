import { Injectable } from '@nestjs/common';
import { ClientSession } from 'mongodb';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock, membershipEndDate } from '../../common/utils/business-date';
import { todayInVietnam } from '../../common/utils/normalization';
import { addVnd, fromVndDecimal, toVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { MembersRepository } from '../members/members.repository';
import { PreferredPaymentMethod, SaleChannel } from '../memberships/schemas/service-sale.schema';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { PlansReader } from '../plans/plans.reader';
import { CONVERSION_RULE } from '../plans/schemas/plan-policy.schema';
import { ActivationResult, ActivationTarget, invalidState } from './sale-activation.contract';
import { SaleReader } from './sale-reader.service';
import { SalesRepository } from './sales.repository';
import { RenewalsRepository } from './renewals.repository';
import { UpgradeBookingsAdapter } from './upgrade-bookings.adapter';
import { readUpgradeQuote, UpgradeQuote, valueUpgrade } from './upgrade-valuation';
import { UpgradeDto, UpgradeSourceDto } from './upgrades.dto';
import { UpgradesRepository } from './upgrades.repository';
import { ZeroSettlement } from './zero-settlement.service';

@Injectable()
export class UpgradeService {
  constructor(private readonly repository: SalesRepository, private readonly upgrades: UpgradesRepository,
    private readonly pending: RenewalsRepository, private readonly bookings: UpgradeBookingsAdapter,
    private readonly members: MembersRepository, private readonly plans: PlansReader, private readonly clock: ServerClock,
    private readonly guards: DataGuardsService, private readonly transactions: TransactionRunner,
    private readonly commands: IdempotencyService, private readonly reader: SaleReader, private readonly zero: ZeroSettlement) {}

  private normalize(input: UpgradeDto) {
    for (const version of [input.sourceVersion, input.targetPlanVersion, input.policyVersion]) {
      if (!Number.isSafeInteger(version) || version < 0) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Phiên bản không hợp lệ');
    }
    return { memberId: objectId(input.memberId).toHexString(), sourceMembershipId: objectId(input.sourceMembershipId).toHexString(),
      sourceVersion: input.sourceVersion, targetPlanId: objectId(input.targetPlanId).toHexString(),
      targetPlanVersion: input.targetPlanVersion, policyVersion: input.policyVersion };
  }
  private async source(memberId: Types.ObjectId, membershipId: Types.ObjectId, today: string, session?: ClientSession, version?: number) {
    const source = await this.upgrades.source(memberId, membershipId, session);
    if (!source) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy kỳ gói của hội viên');
    if (version !== undefined && source.membership.version !== version) throw conflict('SOURCE_CHANGED', 'Kỳ nguồn đã thay đổi. Tải lại và xác nhận');
    const { membership, sale, transaction } = source;
    if (membership.status !== 'ACTIVE' || transaction?.status !== 'SETTLED' || !['GYM', 'PT'].includes(transaction.kind) ||
      sale.start_date > today || sale.end_date < today || sale.kind_snapshot && sale.kind_snapshot !== transaction.kind) {
      throw conflict('SOURCE_NOT_CURRENT', 'Kỳ nguồn phải đang hiệu lực và chưa bị thay thế hoặc hủy');
    }
    const kind = transaction.kind as 'GYM' | 'PT';
    if (await this.upgrades.futurePeriod(memberId, kind, today, session)) throw conflict('FUTURE_PERIOD_EXISTS', 'Đã có kỳ tương lai cùng loại, không thể làm đứt chuỗi kỳ');
    return { ...source, transaction, kind };
  }

  targets(input: UpgradeSourceDto) {
    const memberId = objectId(input.memberId), membershipId = objectId(input.sourceMembershipId);
    return this.transactions.run(async session => {
      const now = this.clock.now();
      const source = await this.source(memberId, membershipId, todayInVietnam(now), session);
      const edges = await this.plans.activeConversions(source.sale.plan_id.toHexString(), session);
      const items = [];
      for (const edge of edges) {
        const plan = await this.plans.findById(edge.to_plan_id.toHexString(), session);
        if (edge.rule_code !== CONVERSION_RULE || !plan || plan.status !== 'ACTIVE' || plan.kind !== source.kind) continue;
        items.push({ planId: plan._id.toHexString(), planVersion: plan.version, policyVersion: edge.version,
          policyId: edge._id.toHexString(), name: plan.name, kind: plan.kind, price: fromVndDecimal(plan.price),
          durationDays: plan.duration_days, sessions: plan.session_quota, benefits: plan.benefits });
      }
      return { source: { membershipId: input.sourceMembershipId.toLowerCase(), version: source.membership.version,
        planId: source.sale.plan_id.toHexString(), planName: source.sale.plan_name_snapshot, kind: source.kind,
        startDate: source.sale.start_date, endDate: source.sale.end_date, sessionsUsed: source.membership.sessions_used,
        sessionsQuota: source.sale.sessions_snapshot, benefits: source.sale.benefits_snapshot }, items, asOf: now.toISOString() };
    });
  }

  private async terms(input: UpgradeDto, session: ClientSession) {
    const now = this.clock.now(), today = todayInVietnam(now), memberId = objectId(input.memberId);
    if (!await this.members.findById(memberId, session)) throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hội viên');
    const source = await this.source(memberId, objectId(input.sourceMembershipId), today, session, input.sourceVersion);
    const plan = await this.plans.findById(input.targetPlanId, session);
    if (!plan || plan.status !== 'ACTIVE') throw conflict('PLAN_NOT_AVAILABLE', 'Gói đích không còn được bán');
    if (plan.version !== input.targetPlanVersion) throw conflict('PLAN_CHANGED', 'Gói đích đã thay đổi');
    const edge = await this.plans.conversionPolicy(source.sale.plan_id.toHexString(), input.targetPlanId, session);
    if (source.sale.plan_id.equals(plan._id) || source.kind !== plan.kind || !edge || edge.status !== 'ACTIVE' || edge.rule_code !== CONVERSION_RULE) {
      throw conflict('POLICY_NOT_ALLOWED', 'Không có chính sách chuyển đổi hợp lệ cho cặp gói này');
    }
    if (edge.version !== input.policyVersion) throw conflict('POLICY_CHANGED', 'Chính sách đã thay đổi. Hãy tải lại và xác nhận');
    const valuation = valueUpgrade({ startDate: source.sale.start_date, endDate: source.sale.end_date, asOfDate: today,
      sourceAmountDue: fromVndDecimal(source.transaction.amount_due), sourceCredit: fromVndDecimal(source.sale.credit_amount), targetListPrice: fromVndDecimal(plan.price) });
    const usage = await this.bookings.inspect({ memberId, membershipId: source.membership._id, kind: source.kind,
      used: source.membership.sessions_used, targetSessions: plan.session_quota, startDate: today,
      endDate: membershipEndDate(today, plan.duration_days), now }, session);
    const blockingCode = await this.pending.pending(memberId, source.kind, session) ? 'PENDING_SALE_EXISTS' : usage.blockingCode;
    const quote: UpgradeQuote = { ...valuation, sourceMembershipId: input.sourceMembershipId, sourceVersion: input.sourceVersion,
      previousSaleId: source.sale._id.toHexString(), sourceEndDate: source.sale.end_date, targetPlanId: input.targetPlanId,
      targetPlanVersion: plan.version, policyId: edge._id.toHexString(), policyVersion: edge.version,
      targetListPrice: fromVndDecimal(plan.price), targetDurationDays: plan.duration_days, targetSessions: plan.session_quota, quotaSummary: usage.quotaSummary };
    return { source, plan, edge, now, quote, blockingCode };
  }

  preview(dto: UpgradeDto) {
    const input = this.normalize(dto);
    return this.transactions.run(async session => {
      const terms = await this.terms(input, session);
      return { ...terms.quote, canProceed: !terms.blockingCode, ...(terms.blockingCode ? { blockingCode: terms.blockingCode } : {}) };
    });
  }

  // US-20 supplies its own ownership adapter, then calls this same engine with SELF_SERVICE.
  // US-20-TC09: Member truyền thêm cách trả dự kiến; quầy không truyền nên giữ nguyên như US-16.
  // US-20-TC10: cách trả nằm trong payload của khóa → cùng key mà đổi cách trả thì 409 IDEMPOTENCY_CONFLICT.
  create(actorId: string, dto: UpgradeDto, key: string, channel: SaleChannel = 'COUNTER', preferredPaymentMethod?: PreferredPaymentMethod) {
    const input = this.normalize(dto), actor = objectId(actorId).toHexString();
    const payload = { ...input, actorId: actor, channel, preferredPaymentMethod };
    return this.commands.execute({ actorId: actor, operation: 'SALE_UPGRADE', clientKey: key, payload }, async session => {
      const source = await this.upgrades.source(objectId(input.memberId), objectId(input.sourceMembershipId), session);
      if (!source) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy kỳ gói của hội viên');
      if (!await this.plans.findById(input.targetPlanId, session) || !await this.plans.findById(source.sale.plan_id.toHexString(), session)) throw conflict('POLICY_NOT_ALLOWED', 'Thiếu gói trong chính sách chuyển đổi');
      if (!await this.members.findById(objectId(input.memberId), session)) throw new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hội viên');
      // US-12 policy writers lock BOTH endpoints. These same locks freeze policy + target terms before the member gate.
      await this.guards.acquire(session, { plans: [source.sale.plan_id, objectId(input.targetPlanId)], members: [objectId(input.memberId)] });
      const terms = await this.terms(input, session);
      if (terms.blockingCode) throw conflict(terms.blockingCode, 'Quota, lịch PT hoặc giao dịch chờ không cho phép nâng cấp');
      const saleId = new Types.ObjectId(), transactionId = new Types.ObjectId(), q = terms.quote, plan = terms.plan;
      await this.repository.transactions.create([{ _id: transactionId, id: transactionId, member_id: input.memberId, created_by: actor,
        code: `TX-${transactionId.toHexString()}`, kind: terms.source.kind, amount_due: toVndDecimal(q.amountDue), status: 'PENDING',
        request_key: transactionRequestKey(actor, 'SALE_UPGRADE', key), created_at: terms.now, version: 0, guard_revision: 0n }], { session });
      await this.repository.sales.create([{ _id: saleId, id: saleId, transaction_id: transactionId, member_id: input.memberId, plan_id: plan._id,
        operation: 'UPGRADE', previous_sale_id: terms.source.sale._id, channel, preferred_payment_method: preferredPaymentMethod, source_membership_id: input.sourceMembershipId,
        source_version_snapshot: input.sourceVersion, conversion_policy_id: terms.edge._id, conversion_policy_version_snapshot: terms.edge.version,
        valuation_date: q.asOfDate, quote_expires_at: new Date(q.quoteExpiresAt), raw_credit_snapshot: toVndDecimal(q.rawCredit),
        excess_credit_snapshot: toVndDecimal(q.excessCredit), credit_amount: toVndDecimal(q.appliedCredit), carried_sessions_used_snapshot: q.quotaSummary.used,
        requested_start_date: q.asOfDate, start_date: q.asOfDate, end_date: membershipEndDate(q.asOfDate, plan.duration_days),
        duration_days_snapshot: plan.duration_days, kind_snapshot: plan.kind, plan_version_snapshot: plan.version, plan_name_snapshot: plan.name,
        benefits_snapshot: plan.benefits, list_price_snapshot: plan.price, sessions_snapshot: plan.session_quota, created_at: terms.now,
        policy_snapshot: JSON.stringify({ rule: 'UPGRADE_V1', dayInclusive: true, rounding: 'HALF_UP', conversionRule: CONVERSION_RULE, quote: q }) }], { session });
      if (q.amountDue === '0') {
        const target = { saleId, transactionId, memberId: objectId(input.memberId) };
        await this.zero.completeZeroWithinSession(session, target, actor, () => this.activateWithinSession(session, target));
      }
      return { status: 201, body: await this.reader.detail(saleId.toHexString(), session), resultIds: { saleId, transactionId } };
    });
  }

  private async inspectPending(target: ActivationTarget, session?: ClientSession) {
    const sale = await this.repository.sales.findOne({ _id: target.saleId, member_id: target.memberId, transaction_id: target.transactionId }).session(session ?? null).lean().exec();
    const transaction = await this.repository.transactions.findById(target.transactionId).session(session ?? null).lean().exec();
    const q = sale ? readUpgradeQuote(sale.policy_snapshot) : null;
    if (!sale || sale.operation !== 'UPGRADE' || !q || !sale.source_membership_id || !sale.previous_sale_id || !sale.quote_expires_at || !sale.duration_days_snapshot ||
      !transaction || transaction.status !== 'PENDING' || !transaction.member_id?.equals(target.memberId) || transaction.kind !== sale.kind_snapshot ||
      addVnd(fromVndDecimal(transaction.amount_due), fromVndDecimal(sale.credit_amount)) !== fromVndDecimal(sale.list_price_snapshot) ||
      q.amountDue !== fromVndDecimal(transaction.amount_due) || q.appliedCredit !== fromVndDecimal(sale.credit_amount)) throw invalidState();
    const now = this.clock.now(), today = todayInVietnam(now);
    if (sale.valuation_date !== today || now >= sale.quote_expires_at) throw conflict('QUOTE_EXPIRED', 'Đề nghị đã hết hạn. Hủy giao dịch chờ và báo giá lại, không sửa số tiền cũ');
    const source = await this.source(target.memberId, sale.source_membership_id, today, session);
    if (!source.sale._id.equals(sale.previous_sale_id) || source.kind !== sale.kind_snapshot) throw conflict('SOURCE_CHANGED', 'Kỳ nguồn không còn phù hợp');
    if (await this.pending.pending(target.memberId, source.kind, session, target.transactionId)) throw conflict('PENDING_SALE_EXISTS', 'Đã có giao dịch chờ cùng loại khác');
    const endDate = membershipEndDate(today, sale.duration_days_snapshot);
    const usage = await this.bookings.inspect({ memberId: target.memberId, membershipId: source.membership._id, kind: source.kind,
      used: source.membership.sessions_used, targetSessions: sale.sessions_snapshot, startDate: today, endDate, now }, session);
    return { sale, transaction, source, now, today, endDate, ...usage };
  }

  async blockingCode(target: ActivationTarget, session?: ClientSession): Promise<string | undefined> {
    try { return (await this.inspectPending(target, session)).blockingCode; }
    catch (error) { if (error instanceof ApplicationError && error.status === 409) return error.code; throw error; }
  }

  // Caller holds member -> transaction (or plan endpoints -> member for a new zero sale). No live plan/policy reads.
  async activateWithinSession(session: ClientSession, target: ActivationTarget): Promise<ActivationResult> {
    if (!session.inTransaction()) throw new Error('SALE_TRANSACTION_REQUIRED');
    const state = await this.inspectPending(target, session);
    if (state.blockingCode) throw conflict(state.blockingCode, 'Quota hoặc lịch PT không còn phù hợp');
    if (await this.repository.memberships.exists({ service_sale_id: target.saleId }).session(session)) throw invalidState();
    if (fromVndDecimal(state.transaction.amount_due) !== '0') {
      const payment = await this.repository.payments.findOne({ transaction_id: target.transactionId, status: 'SUCCEEDED' }).session(session).lean().exec();
      if (!payment || fromVndDecimal(payment.amount) !== fromVndDecimal(state.transaction.amount_due)) throw invalidState();
    }
    const membershipId = new Types.ObjectId(), old = state.source.membership;
    const changed = await this.repository.memberships.updateOne({ _id: old._id, status: 'ACTIVE', version: old.version },
      { $set: { status: 'SUPERSEDED', superseded_at: state.now, superseded_by_membership_id: membershipId }, $inc: { version: 1 } }, { session, runValidators: true });
    if (changed.modifiedCount !== 1) throw conflict('SOURCE_CHANGED', 'Kỳ nguồn đã thay đổi');
    await this.repository.sales.updateOne({ _id: target.saleId }, { $set: { start_date: state.today, end_date: state.endDate,
      carried_sessions_used_snapshot: state.quotaSummary.used } }, { session, runValidators: true });
    await this.repository.memberships.create([{ _id: membershipId, id: membershipId, service_sale_id: target.saleId, status: 'ACTIVE',
      sessions_used: state.quotaSummary.used, created_at: state.now, version: 0 }], { session });
    await this.bookings.moveWithinSession(state.booked.map(row => row._id), target.memberId, old._id, membershipId, state.now, session);
    return { membershipId: membershipId.toHexString(), startDate: state.today, endDate: state.endDate };
  }
}
function objectId(value: string) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new ApplicationError(400, 'VALIDATION_ERROR', 'ID phải là ObjectId hợp lệ');
  return new Types.ObjectId(value);
}
function conflict(code: string, message: string) { return new ApplicationError(409, code, message); }
