import { Injectable } from '@nestjs/common';
import { invalidField } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { CashFlowEventsQueryDto, CashFlowQueryDto } from './cash-flow.dto';
import { cashRange, requireCashEvent, resolveCashFlow, vnDate } from './cash-flow.metrics';
import { CashFlowRepository } from './cash-flow.repository';

@Injectable()
export class CashFlowService {
  constructor(private readonly repository: CashFlowRepository, private readonly clock: ServerClock) {}
  private read<T>(query: CashFlowQueryDto, select: (result: ReturnType<typeof resolveCashFlow>) => T) {
    return this.repository.snapshot(async session => {
      const observedAt = this.clock.now();
      cashRange(query, observedAt); // Reject invalid ranges before reading sources.
      return select(resolveCashFlow(await this.repository.sources(session), query, observedAt));
    });
  }
  summary(query: CashFlowQueryDto) { return this.read(query, result => result.summary); }
  events(query: CashFlowEventsQueryDto) {
    if (!Number.isSafeInteger(query.page * query.limit)) invalidField('page', 'Trang vượt giới hạn cho phép');
    return this.read(query, ({ summary, events }) => {
      const q = query.q?.toLocaleLowerCase('vi-VN');
      const rows = events.filter(row => (query.eventType === 'ALL' || row.eventType === query.eventType) &&
        (!q || [row.eventId, row.paymentId, row.refundId, row.transactionId, row.transactionCode, row.orderId,
          row.orderCode, row.returnId, row.invoiceId, row.invoiceCode].some(v => v?.toLocaleLowerCase('vi-VN').includes(q))));
      return { ...summary, eventFilter: { eventType: query.eventType, q: query.q ?? '' },
        items: rows.slice((query.page - 1) * query.limit, query.page * query.limit), page: query.page, limit: query.limit,
        total: rows.length, totalPages: Math.ceil(rows.length / query.limit) };
    });
  }
  detail(eventType: string, id: string, query: CashFlowQueryDto) {
    return this.repository.snapshot(async session => {
      const observedAt = this.clock.now();
      cashRange(query, observedAt);
      const sources = await this.repository.sources(session);
      const source = (eventType === 'RECEIPT' ? sources.payments : sources.refunds).find(row => String(row._id) === id.toLowerCase());
      const at = eventType === 'RECEIPT' ? source?.paid_at : source?.refunded_at;
      const selected = !query.fromDate && !query.toDate && at instanceof Date && Number.isFinite(at.getTime()) && at <= observedAt
        ? { ...query, fromDate: vnDate(at), toDate: vnDate(at) } : query;
      const { summary, events } = resolveCashFlow(sources, selected, observedAt);
      return { ...summary, event: requireCashEvent(events, eventType, id) };
    });
  }
}
