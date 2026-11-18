import { Injectable } from '@nestjs/common';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { ServerClock } from '../../common/utils/business-date';
import { reportRange } from './report-interval';
import { TrainerPerformanceDetailDto, TrainerPerformanceListDto, TrainerPerformanceRangeDto } from './trainer-performance.dto';
import { resolveTrainerPerformance } from './trainer-performance.metrics';
import { TrainerPerformanceRepository } from './trainer-performance.repository';

function page<T>(rows: T[], current: number, limit: number) {
  return { items: rows.slice((current - 1) * limit, current * limit), page: current, limit, total: rows.length, totalPages: Math.ceil(rows.length / limit) };
}
@Injectable()
export class TrainerPerformanceService {
  constructor(private readonly repository: TrainerPerformanceRepository, private readonly clock: ServerClock) {}
  private read<T>(query: TrainerPerformanceRangeDto, trainerId: string | undefined,
    select: (result: ReturnType<typeof resolveTrainerPerformance>) => T) {
    const observedAt = this.clock.now();
    const range = reportRange(query, observedAt);
    return this.repository.snapshot(async session => {
      const result = resolveTrainerPerformance(await this.repository.sources(session, range, trainerId), range, trainerId);
      return { range, observedAt: observedAt.toISOString(), metricVersion: 'S08-V1',
        dataQuality: result.totals.dataQuality, warningCodes: result.totals.warningCodes, invalidRecordCount: result.totals.invalidRecordCount,
        ...select(result) };
    });
  }
  list(query: TrainerPerformanceListDto) {
    this.checkPage(query.page, query.limit);
    return this.read(query, query.trainerId, result => {
      const search = query.q?.toLocaleLowerCase('vi');
      const rows = result.rows.filter(r => !search || [r.id, r.displayName].some(v => v?.toLocaleLowerCase('vi').includes(search)));
      // q and pagination select the table only; trainerId/date select the reporting population.
      return { ...page(rows.map(({ sourcePages: _sources, ...r }) => r), query.page, query.limit), totals: result.totals,
        filter: { trainerId: query.trainerId?.toLowerCase() ?? null, q: query.q ?? '', qScope: 'TABLE_ONLY' } };
    });
  }
  detail(id: string, query: TrainerPerformanceDetailDto) {
    for (const current of [query.shiftPage, query.attendancePage, query.bookingPage, query.reviewPage]) this.checkPage(current, query.limit);
    return this.read(query, id, result => {
      const row = result.rows.find(r => r.id === id.toLowerCase());
      if (!row) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy PT hoặc lịch sử trong kỳ');
      return { trainer: { id: row.id, displayName: row.displayName, status: row.status }, summary: row.summary,
        sourcePages: { shifts: page(row.sourcePages.shifts, query.shiftPage, query.limit),
          attendance: page(row.sourcePages.attendance, query.attendancePage, query.limit),
          bookings: page(row.sourcePages.bookings, query.bookingPage, query.limit), reviews: page(row.sourcePages.reviews, query.reviewPage, query.limit) } };
    });
  }
  private checkPage(current: number, limit: number) {
    if (!Number.isSafeInteger(current * limit)) invalidField('page', 'Trang vượt giới hạn cho phép');
  }
}
