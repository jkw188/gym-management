// Tầng nghiệp vụ (US-26 bước 1): PublicSessionQueryService – Guest/Member xem lịch lớp miễn phí đã công bố.
// Chỉ đọc: không đăng ký chỗ, không quota, không gửi thông báo (US-26-F04, TC10).
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { PublicSessionQueryDto } from './public-sessions.dto';
import { toPublicSessionResponse } from './public-sessions.mapper';
import { PublicSessionsRepository } from './public-sessions.repository';
import { PublicSession } from './schemas/public-session.schema';
import { PublicSessionPage, PublicSessionResponse, SUBJECTS } from './public-sessions.types';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

@Injectable()
export class PublicSessionQueryService {
  constructor(
    private readonly repository: PublicSessionsRepository,
    // Dùng lại luật đổi ngày Việt Nam → khoảng UTC của US-24 (ngày có thật, tối đa 31 ngày, mặc định tuần này).
    private readonly interval: ShiftIntervalService,
  ) {}

  // GET /api/public-session-subjects: taxonomy S04, cùng danh sách Admin form của US-66 dùng.
  listSubjects() {
    return SUBJECTS.map(subject => ({ code: subject.code, label: subject.label }));
  }

  // GET /api/public-sessions: lịch lớp PUBLISHED theo ngày Việt Nam, bộ môn, PT; có phân trang.
  async list(query: PublicSessionQueryDto): Promise<PublicSessionPage> {
    const serverNow = new Date();
    // US-26-TC06, TC07: ngày Việt Nam → [00:00 ngày đầu, 00:00 ngày sau ngày cuối); ngày sai hoặc quá 31 ngày → 400.
    const range = this.interval.vietnamDateRange(query.fromDate, query.toDate, serverNow);
    const { items, total } = await this.repository.listPublished({
      from: range.from,
      to: range.to,
      subjectCode: query.subjectCode,
      trainerId: query.trainerId ? new Types.ObjectId(query.trainerId) : undefined,
    }, query.page, query.limit);
    return {
      items: await this.toResponses(items, serverNow),
      page: query.page,
      limit: query.limit,
      total,
      // US-26-TC04: danh sách rỗng thì totalPages = 0.
      totalPages: Math.ceil(total / query.limit),
    };
  }

  // GET /api/public-sessions/:id: chỉ lớp PUBLISHED.
  async detail(sessionId: string): Promise<PublicSessionResponse> {
    // Id sai định dạng là dữ liệu sai → 400.
    if (!OBJECT_ID.test(sessionId)) throw new ApplicationError(400, 'INVALID_ID', 'Mã lớp không hợp lệ');
    const session = await this.repository.findPublished(new Types.ObjectId(sessionId));
    // US-26-TC02, TC09: không tồn tại, nháp hoặc đã hủy đều 404, không lộ lớp đó có hay không.
    if (!session) throw new ApplicationError(404, 'SESSION_NOT_FOUND', 'Lớp không còn được công bố');
    const [response] = await this.toResponses([session], new Date());
    return response;
  }

  // Gắn tên PT cho từng lớp: đọc tên một lần cho cả trang, không đọc từng lớp.
  private async toResponses(sessions: PublicSession[], serverNow: Date): Promise<PublicSessionResponse[]> {
    const names = await this.repository.findTrainerNames(sessions.map(session => session.trainer_id));
    return sessions.map(session => toPublicSessionResponse(session, names.get(session.trainer_id.toHexString()) ?? null, serverNow));
  }
}
