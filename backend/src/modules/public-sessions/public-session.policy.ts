import { invalidField } from '../../common/errors/application-error';
import { ShiftIntervalService } from '../shifts/shift-interval.service';
import { CreatePublicSessionDto } from './admin-public-sessions.dto';
import { SUBJECT_CODES } from './public-sessions.types';

export function sessionDraft(input: CreatePublicSessionDto, interval: ShiftIntervalService) {
  if (!SUBJECT_CODES.includes(input.subjectCode)) invalidField('subjectCode', 'Bộ môn không hợp lệ');
  const startAt = interval.parseInstant(input.startAt, 'startAt');
  const endAt = interval.parseInstant(input.endAt, 'endAt');
  if (endAt <= startAt) invalidField('endAt', 'Giờ kết thúc phải sau giờ bắt đầu');
  const dayMs = 86400000, offsetMs = 7 * 3600000;
  const nextMidnight = (Math.floor((startAt.getTime() + offsetMs) / dayMs) + 1) * dayMs - offsetMs;
  if (endAt.getTime() > nextMidnight) invalidField('endAt', 'Lớp không được qua nửa đêm Việt Nam');
  return { title: sessionText(input.title, 'title', 1, 120), trainerId: input.trainerId.toLowerCase(),
    subjectCode: input.subjectCode, location: sessionText(input.location, 'location', 1, 120), startAt, endAt };
}

export function sessionText(value: string, field: string, min: number, max: number) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    invalidField(field, `${field} phải từ ${min} đến ${max} ký tự`);
  }
  return value.trim();
}

export type SessionDraft = ReturnType<typeof sessionDraft>;
