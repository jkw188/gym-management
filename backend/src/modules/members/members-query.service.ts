import { Injectable } from '@nestjs/common';
import { ObjectId } from 'mongodb';
import { ApplicationError } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { normalizePhone, todayInVietnam, validateObjectId } from '../../common/utils/normalization';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { MemberPaginationDto, MembersQueryDto, EntitlementSummaryDto, MemberMembershipDto, MemberTransactionDto } from './members-query.dto';
import { MembersQueryRepository, StateGroup } from './members-query.repository';
import { toMemberResponse } from './members.mapper';
import { membershipTimeState } from './membership-time-state';

@Injectable()
export class MembersQueryService {
  constructor(private readonly repository: MembersQueryRepository, private readonly clock: ServerClock) {}

  async list(query: MembersQueryDto) {
    this.checkPage(query);
    const time = this.readTime();
    const literal = query.q?.trim();
    let phone: string | undefined;
    if (literal) {
      try { phone = normalizePhone(literal); } catch { /* Không phải phone đầy đủ: tìm literal. */ }
    }
    const data = await this.repository.list(query, time.businessDate, literal ? { literal, phone } : undefined);
    return this.page(data.items.map(member => ({ id: member._id.toHexString(), memberCode: member.member_code,
      fullName: member.full_name, phone: member.phone, accountLinked: !!member.account_id,
      entitlementSummary: this.summary(member.entitlement) })), data.count, query, time);
  }
  async detail(memberId: string) {
    const id = new ObjectId(validateObjectId(memberId));
    const time = this.readTime();
    const member = await this.repository.detail(id, time.businessDate);
    if (!member) throw this.notFound();
    return { member: toMemberResponse(member), entitlementSummary: this.summary(member.entitlement), ...time };
  }
  async memberships(memberId: string, query: MemberPaginationDto) {
    this.checkPage(query);
    const time = this.readTime();
    const id = await this.memberId(memberId);
    const data = await this.repository.memberships(id, query);
    const items: MemberMembershipDto[] = data.items.map(item => ({ membershipId: item._id.toHexString(),
      saleId: item.sale_id.toHexString(), kind: item.kind, planName: item.plan_name,
      startDate: item.start_date, endDate: item.end_date, storedStatus: item.stored_status,
      timeState: membershipTimeState(item.stored_status, item.transaction_status, item.start_date, item.end_date, time.businessDate),
      sessionsQuota: Number(item.sessions_quota), sessionsUsed: Number(item.sessions_used), transactionStatus: item.transaction_status }));
    return this.page(items, data.count, query, time);
  }
  async transactions(memberId: string, query: MemberPaginationDto) {
    this.checkPage(query);
    const time = this.readTime();
    const id = await this.memberId(memberId);
    const data = await this.repository.transactions(id, query);
    const items: MemberTransactionDto[] = data.items.map(item => ({ id: item._id.toHexString(), code: item.code,
      kind: item.kind, status: item.status, amountDue: fromVndDecimal(item.amount_due), createdAt: item.created_at.toISOString(),
      ...(item.payments[0] ? { paymentId: item.payments[0]._id.toHexString() } : {}),
      ...(item.invoices[0] ? { invoiceId: item.invoices[0]._id.toHexString() } : {}) }));
    return this.page(items, data.count, query, time);
  }
  private readTime() {
    const now = this.clock.now();
    return { asOf: now.toISOString(), businessDate: todayInVietnam(now) };
  }
  private summary(groups: StateGroup[]): EntitlementSummaryDto {
    const states = (kind: 'GYM' | 'PT') => {
      const group = groups.find(item => item._id === kind);
      return group ? (['CURRENT', 'SCHEDULED', 'EXPIRED'] as const).filter(state => group.states.includes(state)) : ['NONE'] as const;
    };
    return { GYM: [...states('GYM')], PT: [...states('PT')] };
  }
  private page<T>(items: T[], count: { total: number }[], query: MemberPaginationDto, time: ReturnType<MembersQueryService['readTime']>) {
    const total = count[0]?.total ?? 0;
    return { items, page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit), ...time };
  }
  private checkPage(query: MemberPaginationDto) {
    if (!Number.isSafeInteger((query.page - 1) * query.limit)) {
      throw new ApplicationError(400, 'VALIDATION_ERROR', 'Trang vượt giới hạn cho phép');
    }
  }
  private async memberId(value: string) {
    const id = new ObjectId(validateObjectId(value));
    if (!await this.repository.exists(id)) throw this.notFound();
    return id;
  }
  private notFound() { return new ApplicationError(404, 'MEMBER_NOT_FOUND', 'Không tìm thấy hồ sơ hội viên'); }
}
