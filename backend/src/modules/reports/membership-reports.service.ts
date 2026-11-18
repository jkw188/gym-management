import { Injectable } from '@nestjs/common';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { MembershipMembersQueryDto, MembershipReportTimeDto, MembershipSummaryQueryDto } from './membership-reports.dto';
import { MembershipReportsRepository } from './membership-reports.repository';
import { resolveMemberships } from './membership-interval';

@Injectable()
export class MembershipReportsService {
  constructor(private readonly repository: MembershipReportsRepository,
    private readonly transactions: TransactionRunner, private readonly clock: ServerClock) {}

  private snapshot<T>(query: MembershipReportTimeDto & { kind?: 'ALL' | 'GYM' | 'PT' },
    select: (result: ReturnType<typeof resolveMemberships>) => T) {
    return this.transactions.run(async session => {
      const observedAt = this.clock.now();
      const at = query.asOfAt ? new Date(query.asOfAt) : observedAt;
      if (!Number.isFinite(at.getTime()) || at > observedAt) invalidField('asOfAt', 'Thời điểm phải hợp lệ và không sau giờ server');
      const kind = query.kind ?? 'ALL';
      const result = resolveMemberships(await this.repository.sources(session), at.getTime(), kind);
      return { asOfAt: at.toISOString(), observedAt: observedAt.toISOString(), metricVersion: 'S08-V1',
        filter: { kind }, ...result.summary, ...select(result) };
    });
  }
  summary(query: MembershipSummaryQueryDto) { return this.snapshot(query, () => ({})); }

  members(query: MembershipMembersQueryDto) {
    if (!Number.isSafeInteger(query.page * query.limit)) invalidField('page', 'Trang vượt giới hạn cho phép');
    return this.snapshot(query, result => {
      // String.includes is literal (no regular expression or Mongo query interpolation).
      const q = query.q?.toLocaleLowerCase('vi-VN');
      const rows = result.rows.filter(row => (query.activity === 'ALL' || row.activity === query.activity) &&
        (!q || `${row.code ?? ''} ${row.displayName ?? ''}`.toLocaleLowerCase('vi-VN').includes(q)));
      return { items: rows.slice((query.page - 1) * query.limit, query.page * query.limit),
        page: query.page, limit: query.limit, total: rows.length, totalPages: Math.ceil(rows.length / query.limit),
        filter: { kind: query.kind, activity: query.activity, q: query.q ?? '' } };
    });
  }
  detail(id: string, query: MembershipReportTimeDto) {
    return this.snapshot(query, result => {
      const member = result.rows.find(row => row.memberId === id.toLowerCase());
      if (!member) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy hội viên tại thời điểm chọn');
      return { member, memberships: (result.views.get(member.memberId) ?? []).sort((a, b) =>
        (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || (b.membershipId ?? '').localeCompare(a.membershipId ?? '')) };
    });
  }
}
