// Tầng nghiệp vụ (US-24 bước 1–2): luật thời gian dùng chung của ca làm việc, không đọc/ghi DB.
// Kiểm ca nháp hợp lệ, quy tắc chồng khoảng [start, end), xem trước slot 60 phút và đổi ngày lọc Việt Nam sang UTC; US-27/US-28 dùng lại.
import { Injectable } from '@nestjs/common';
import { invalidField } from '../../common/errors/application-error';
import { DateRange, SlotPreview, TimeInterval, ValidDraft } from './shifts.types';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Việt Nam dùng UTC+7 cố định, không có giờ mùa hè.
const VIETNAM_OFFSET_MS = 7 * HOUR_MS;
// Ca tối thiểu 60 phút và mỗi slot dài 60 phút (US-24-F02).
const MIN_SHIFT_MS = 60 * MINUTE_MS;
const SLOT_MS = 60 * MINUTE_MS;
// Bộ lọc lịch xem tối đa 31 ngày (tính cả ngày đầu và ngày cuối).
const MAX_FILTER_DAYS = 31;

// ISO 8601 bắt buộc có Z hoặc offset ±hh:mm. Nhóm: năm, tháng, ngày, giờ, phút, giây, mili giây, timezone.
const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

@Injectable()
export class ShiftIntervalService {
  // Kiểm đầy đủ ca nháp người dùng gửi lên (định dạng + bắt đầu ở tương lai); sai thì ném 400 VALIDATION_ERROR kèm field.
  validateDraft(input: { startAt: unknown; endAt: unknown; location: unknown }, serverNow: Date): ValidDraft {
    const draft = this.parseDraft(input);
    this.assertFutureStart(draft.startAt, serverNow);
    return draft;
  }

  // US-24-TC03: startAt phải lớn hơn hẳn thời điểm hiện tại của server.
  // Tách riêng vì phụ thuộc lúc gửi: service gọi hàm này TRONG callback idempotency, để gửi lại cùng key
  // sau khi ca đã bắt đầu vẫn nhận kết quả gốc thay vì 400 (EN-02).
  assertFutureStart(startAt: Date, serverNow: Date): void {
    if (startAt.getTime() <= serverNow.getTime()) invalidField('startAt', 'Giờ bắt đầu phải ở tương lai');
  }

  // Kiểm định dạng ca nháp, không phụ thuộc thời điểm gửi: cùng dữ liệu thì luôn cho cùng kết quả.
  parseDraft(input: { startAt: unknown; endAt: unknown; location: unknown }): ValidDraft {
    const startAt = this.parseInstant(input.startAt, 'startAt');
    const endAt = this.parseInstant(input.endAt, 'endAt');
    const location = this.normalizeLocation(input.location);

    // US-24-TC03: endAt phải sau startAt.
    if (endAt.getTime() <= startAt.getTime()) invalidField('endAt', 'Giờ kết thúc phải sau giờ bắt đầu');
    // US-24-TC03, US-24-TC04: ca dài ít nhất 60 phút.
    if (endAt.getTime() - startAt.getTime() < MIN_SHIFT_MS) invalidField('endAt', 'Ca phải dài ít nhất 60 phút');
    // US-24-TC04: không qua nửa đêm Việt Nam; kết thúc đúng 00:00 ngày kế tiếp vẫn được.
    if (endAt.getTime() > this.nextVietnamMidnight(startAt).getTime()) {
      invalidField('endAt', 'Ca không được kéo dài qua nửa đêm (giờ Việt Nam)');
    }
    return { startAt, endAt, location };
  }

  // US-24-TC05: hai khoảng [start, end) chồng nhau khi a.start < b.end và b.start < a.end; liền nhau thì không chồng.
  overlaps(a: TimeInterval, b: TimeInterval): boolean {
    return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();
  }

  // US-24-TC01: slot 60 phút bắt đầu từ startAt; phần dư dưới 60 phút không thành slot.
  previewSlots(startAt: Date, endAt: Date): SlotPreview {
    // Khoảng không có độ dài dương (end ≤ start) thì không có slot và không có phần dư, tránh trả số phút âm.
    if (endAt.getTime() <= startAt.getTime()) return { slots: [], remainderMinutes: 0 };
    const slots: TimeInterval[] = [];
    let slotStart = startAt.getTime();
    while (slotStart + SLOT_MS <= endAt.getTime()) {
      slots.push({ startAt: new Date(slotStart), endAt: new Date(slotStart + SLOT_MS) });
      slotStart += SLOT_MS;
    }
    // Sau vòng lặp, slotStart là điểm cuối của slot cuối cùng (hoặc startAt nếu không có slot).
    const remainderMinutes = (endAt.getTime() - slotStart) / MINUTE_MS;
    return { slots, remainderMinutes };
  }

  // Đổi bộ lọc ngày Việt Nam (YYYY-MM-DD, gồm cả hai ngày đầu/cuối) thành khoảng UTC [from, to).
  // Không gửi thì mặc định tuần hiện tại từ thứ Hai; tối đa 31 ngày (mục 2 của spec, US-24-TC03).
  vietnamDateRange(fromDate: string | undefined, toDate: string | undefined, serverNow: Date): DateRange {
    // "Nửa đêm UTC" của ngày Việt Nam hôm nay; getUTCDay(): 0 = Chủ nhật, 1 = thứ Hai…
    const today = new Date(Math.floor((serverNow.getTime() + VIETNAM_OFFSET_MS) / DAY_MS) * DAY_MS);
    const daysSinceMonday = (today.getUTCDay() + 6) % 7;
    const monday = new Date(today.getTime() - daysSinceMonday * DAY_MS);

    const fromDay = fromDate === undefined ? monday : this.parseDateOnly(fromDate, 'fromDate');
    const toDay = toDate === undefined ? new Date(fromDay.getTime() + 6 * DAY_MS) : this.parseDateOnly(toDate, 'toDate');
    if (toDay.getTime() < fromDay.getTime()) invalidField('toDate', 'toDate không được trước fromDate');
    const dayCount = (toDay.getTime() - fromDay.getTime()) / DAY_MS + 1;
    if (dayCount > MAX_FILTER_DAYS) invalidField('toDate', 'Chỉ xem tối đa 31 ngày mỗi lần');

    // 00:00 giờ Việt Nam = 17:00 UTC ngày hôm trước, nên trừ 7 giờ. to là 00:00 của ngày sau toDate.
    return {
      from: new Date(fromDay.getTime() - VIETNAM_OFFSET_MS),
      to: new Date(toDay.getTime() + DAY_MS - VIETNAM_OFFSET_MS),
    };
  }

  // "YYYY-MM-DD" → Date lúc 00:00 UTC của ngày đó; ngày không có thật (30/02) → 400.
  private parseDateOnly(value: string, field: string): Date {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    // Date.UTC tự "tràn" 30/02 thành 02/03, nên so lại từng phần để phát hiện ngày không có thật.
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
      invalidField(field, 'Ngày không hợp lệ');
    }
    return date;
  }

  // Đổi chuỗi ISO có timezone thành Date. US-24-TC03: thiếu offset, ngày không có thật, có giây/mili giây → 400.
  private parseInstant(value: unknown, field: string): Date {
    if (typeof value !== 'string') invalidField(field, 'Thời điểm phải là chuỗi ISO 8601 có múi giờ');
    const match = ISO_WITH_OFFSET.exec(value);
    if (!match) invalidField(field, 'Thời điểm phải có Z hoặc offset, ví dụ 2026-12-01T08:00:00+07:00');
    const [, year, month, day, hour, minute, second, millisecond, zone] = match;

    // Thời điểm nhập chỉ đến phút: giây và mili giây phải bằng 0.
    if (Number(second ?? 0) !== 0 || Number(millisecond ?? 0) !== 0) invalidField(field, 'Thời điểm chỉ nhập đến phút');

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) invalidField(field, 'Thời điểm không hợp lệ');

    // Kiểm ngày có thật (ví dụ 30/02): cộng lại offset rồi so từng phần với chuỗi đã nhập.
    const local = new Date(date.getTime() + this.offsetToMs(zone));
    const sameAsInput = local.getUTCFullYear() === Number(year)
      && local.getUTCMonth() + 1 === Number(month)
      && local.getUTCDate() === Number(day)
      && local.getUTCHours() === Number(hour)
      && local.getUTCMinutes() === Number(minute);
    if (!sameAsInput) invalidField(field, 'Thời điểm không hợp lệ');
    return date;
  }

  // "Z" → 0; "+07:00" → 7 giờ; "-05:30" → âm 5 giờ 30 phút (đổi ra mili giây).
  private offsetToMs(zone: string): number {
    if (zone === 'Z') return 0;
    const sign = zone.startsWith('-') ? -1 : 1;
    const [hours, minutes] = zone.slice(1).split(':').map(Number);
    return sign * (hours * HOUR_MS + minutes * MINUTE_MS);
  }

  // 00:00 giờ Việt Nam của ngày kế tiếp sau startAt, trả về Date UTC.
  private nextVietnamMidnight(startAt: Date): Date {
    // Số thứ tự ngày (theo lịch Việt Nam) tính từ 01/01/1970 của thời điểm bắt đầu.
    const vietnamDay = Math.floor((startAt.getTime() + VIETNAM_OFFSET_MS) / DAY_MS);
    return new Date((vietnamDay + 1) * DAY_MS - VIETNAM_OFFSET_MS);
  }

  // location trim 1–120 ký tự (US-24-F02).
  // Đếm bằng .length (đơn vị UTF-16) giống maxlength của schema và maxLength của ô input HTML;
  // nếu đếm khác nhau thì dữ liệu qua service vẫn có thể bị schema chặn (ví dụ emoji tính 2).
  private normalizeLocation(value: unknown): string {
    if (typeof value !== 'string') invalidField('location', 'Địa điểm phải từ 1 đến 120 ký tự');
    const location = value.trim();
    if (location.length < 1 || location.length > 120) invalidField('location', 'Địa điểm phải từ 1 đến 120 ký tự');
    return location;
  }
}
