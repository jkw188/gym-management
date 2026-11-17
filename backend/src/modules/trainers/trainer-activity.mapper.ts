import { Document, ObjectId } from 'mongodb';
import { ActivityBooking, ActivityShift } from './trainer-activity.types';

export const sourceId = (value: unknown): string | null => value instanceof ObjectId ? value.toHexString() : null;
export const sourceDate = (value: unknown): string | null => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const integer = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

// Allowlist only: no operation keys, arbitrary audit payloads or source URLs from stored data.
export function activityShift(row: Document): ActivityShift {
  const records: Document[] = row.attendance ?? [];
  const attendance = records[0];
  const checkInAt = sourceDate(attendance?.check_in_at);
  const checkOutAt = sourceDate(attendance?.check_out_at);
  const state = !attendance ? 'MISSING' : attendance.check_out_at == null ? 'OPEN' : 'CLOSED';
  const dataIssue: string[] = [];
  if (!row.trainerExists) dataIssue.push('TRAINER_MISSING');
  if (records.length > 1) dataIssue.push('DUPLICATE_ATTENDANCE');
  if (attendance && (sourceId(attendance.trainer_id) !== sourceId(row.trainer_id) || !sourceId(attendance.recorded_by))) dataIssue.push('ATTENDANCE_SOURCE_INVALID');
  let actualMinutes: number | null = null;
  if (state === 'CLOSED' && checkInAt && checkOutAt && Date.parse(checkOutAt) > Date.parse(checkInAt) && records.length === 1 && sourceId(attendance?.trainer_id) === sourceId(row.trainer_id)) {
    actualMinutes = (Date.parse(checkOutAt) - Date.parse(checkInAt)) / 60000;
  } else if (attendance && (!checkInAt || state === 'CLOSED' && (!checkOutAt || Date.parse(checkOutAt) <= Date.parse(checkInAt)))) {
    dataIssue.push('ATTENDANCE_TIME_INVALID');
  }
  return {
    id: sourceId(row._id)!, trainerId: sourceId(row.trainer_id), startAt: sourceDate(row.start_at), endAt: sourceDate(row.end_at),
    status: text(row.status), location: text(row.location), dataIssue,
    attendance: { id: sourceId(attendance?._id), state, checkInAt, checkOutAt, actualMinutes,
      recordedBy: sourceId(attendance?.recorded_by), checkedOutBy: sourceId(attendance?.checked_out_by),
      version: integer(attendance?.version), lastCorrectedBy: sourceId(attendance?.last_corrected_by), lastCorrectedAt: sourceDate(attendance?.last_corrected_at) },
  };
}
export function activityBooking(row: Document): ActivityBooking {
  const dataIssue: string[] = [];
  if (!row.trainerExists) dataIssue.push('TRAINER_MISSING');
  if (!row.memberExists) dataIssue.push('MEMBER_MISSING');
  if (!row.shiftExists) dataIssue.push('SHIFT_MISSING');
  if (row.status === 'COMPLETED' && (!sourceDate(row.completed_at) || !sourceId(row.completed_by))) dataIssue.push('COMPLETION_SOURCE_INVALID');
  return { id: sourceId(row._id)!, trainerId: sourceId(row.trainer_id), memberId: sourceId(row.member_id),
    startAt: sourceDate(row.start_at), endAt: sourceDate(row.end_at), status: text(row.status),
    completedAt: sourceDate(row.completed_at), completedBy: sourceId(row.completed_by), completionRevision: integer(row.completion_revision), dataIssue };
}
