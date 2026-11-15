import { Db, Document } from 'mongodb';
import { createHash } from 'node:crypto';

const id = (value: unknown) => String(value);
const overlaps = (a: Document, b: Document) => a.start_at < b.end_at && b.start_at < a.end_at;
function requireInvariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`EN05_INVARIANT_${code}`);
}
function unique(rows: Document[], fields: string[], code: string) {
  const keys = rows.map(row => fields.map(field => id(row[field])).join('|'));
  requireInvariant(new Set(keys).size === keys.length, code);
}
function pairs(rows: Document[], fields: string[], code: string) {
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    requireInvariant(!fields.some(field => id(rows[i][field]) === id(rows[j][field])) || !overlaps(rows[i], rows[j]), code);
  }
}

// Independent oracle: committed documents, no availability API or HTTP success counting.
export async function inspectCommitted(db: Db) {
  const names = ['pt_bookings', 'memberships', 'service_sales', 'transactions', 'members', 'trainers', 'work_shifts',
    'public_sessions', 'public_session_events', 'trainer_events', 'operation_requests', 'booking_events', 'notifications', 'notification_recipients', 'notification_outbox'];
  const loaded = await Promise.all(names.map(name => db.collection(name).find({}, { readConcern: { level: 'majority' } }).toArray()));
  const data = Object.fromEntries(names.map((name, i) => [name, loaded[i]]));
  const find = (name: string, value: unknown) => data[name].find(row => id(row._id) === id(value));
  const bookings = data.pt_bookings, active = bookings.filter(row => ['BOOKED', 'COMPLETED'].includes(row.status));
  const classes = data.public_sessions.filter(row => row.status === 'PUBLISHED');
  pairs(active, ['trainer_id', 'member_id'], 'BOOKING_OVERLAP');
  pairs(classes, ['trainer_id'], 'CLASS_OVERLAP');
  pairs(data.work_shifts.filter(row => ['SCHEDULED', 'CONFIRMED'].includes(row.status)), ['trainer_id'], 'SHIFT_OVERLAP');
  for (const booking of bookings) {
    const membership = find('memberships', booking.membership_id), sale = membership && find('service_sales', membership.service_sale_id);
    requireInvariant(sale && id(sale.member_id) === id(booking.member_id), 'BOOKING_OWNER');
    requireInvariant(find('members', booking.member_id) && find('trainers', booking.trainer_id) && find('work_shifts', booking.shift_id), 'BOOKING_ORPHAN');
    requireInvariant(booking.end_at.getTime() - booking.start_at.getTime() === 3600000, 'SLOT_60');
    requireInvariant(data.notifications.filter(row => row.event_key === `BOOKING_CREATED:${booking._id}`).length === 1, 'BOOKING_CREATION_EVENT');
    requireInvariant(data.operation_requests.filter(row => row.operation === 'PT_BOOKING_CREATE' && id(row.result_ids?.bookingId) === id(booking._id)).length === 1, 'BOOKING_CREATION_OPERATION');
    if (booking.status === 'CANCELLED') {
      requireInvariant(data.booking_events.filter(row => id(row.booking_id) === id(booking._id) && row.action === 'CANCELLED').length === 1, 'BOOKING_CANCEL_AUDIT');
      requireInvariant(data.notifications.filter(row => row.event_key === `BOOKING_CANCELLED:${booking._id}`).length === 1, 'BOOKING_CANCEL_EVENT');
    }
    if (booking.status === 'BOOKED') {
      requireInvariant(membership!.status === 'ACTIVE', 'BOOKING_ACTIVE_MEMBERSHIP');
      requireInvariant(booking.start_at >= new Date(`${sale.start_date}T00:00:00+07:00`) &&
        booking.end_at <= new Date(new Date(`${sale.end_date}T00:00:00+07:00`).getTime() + 86400000), 'BOOKING_PERIOD');
      const shift = find('work_shifts', booking.shift_id)!;
      requireInvariant(shift.status === 'CONFIRMED' && id(shift.trainer_id) === id(booking.trainer_id) &&
        booking.start_at >= shift.start_at && booking.end_at <= shift.end_at, 'BOOKING_SHIFT');
    }
    if (['BOOKED', 'COMPLETED'].includes(booking.status)) for (const session of classes) {
      requireInvariant(id(session.trainer_id) !== id(booking.trainer_id) || !overlaps(session, booking), 'CLASS_BOOKING_OVERLAP');
    }
  }
  const quota = data.memberships.map(membership => {
    const sale = find('service_sales', membership.service_sale_id);
    requireInvariant(sale && find('transactions', sale.transaction_id) && find('members', sale.member_id), 'MEMBERSHIP_ORPHAN');
    const used = Number(membership.sessions_used), reserved = bookings.filter(row => id(row.membership_id) === id(membership._id) && row.status === 'BOOKED').length;
    const limit = Number(sale.sessions_snapshot);
    requireInvariant(Number.isSafeInteger(used) && used >= 0 && Number.isSafeInteger(limit) && used + reserved <= limit, 'QUOTA');
    return { id: id(membership._id), saleId: id(sale._id), memberId: id(sale.member_id), status: membership.status,
      used, reserved, quota: limit, startDate: sale.start_date, endDate: sale.end_date };
  });
  unique(data.operation_requests, ['actor_id', 'operation', 'client_key'], 'OPERATION_UNIQUE');
  unique(data.notifications, ['event_key'], 'EVENT_UNIQUE');
  unique(data.notification_outbox, ['event_key'], 'OUTBOX_UNIQUE');
  unique(data.notification_recipients, ['notification_id', 'account_id'], 'RECIPIENT_UNIQUE');
  unique(data.booking_events, ['request_key'], 'AUDIT_UNIQUE');
  unique(data.trainers, ['account_id'], 'TRAINER_ACCOUNT_UNIQUE');
  unique(data.trainer_events, ['request_key'], 'TRAINER_AUDIT_UNIQUE');
  unique(data.public_session_events, ['request_key'], 'CLASS_AUDIT_UNIQUE');
  for (const audit of data.public_session_events) {
    requireInvariant(find('public_sessions', audit.session_id), 'CLASS_AUDIT_ORPHAN');
    const operation = data.operation_requests.find(row => row.operation === `PUBLIC_SESSION_${audit.action === 'CREATED' ? 'CREATE' : audit.action === 'UPDATED' ? 'UPDATE' : audit.action === 'PUBLISHED' ? 'PUBLISH' : 'CANCEL'}` &&
      id(row.result_ids?.sessionId) === id(audit.session_id) && id(row.actor_id) === id(audit.actor_id) &&
      row.response_body.version === audit.after.version);
    requireInvariant(operation, 'CLASS_AUDIT_OPERATION');
    requireInvariant(audit.action === 'CREATED' ? audit.after.version === 0 : audit.after.version === audit.before.version + 1, 'CLASS_AUDIT_VERSION');
  }
  for (const audit of data.trainer_events) requireInvariant(find('trainers', audit.trainer_id), 'TRAINER_AUDIT_ORPHAN');
  for (const audit of data.booking_events) requireInvariant(find('pt_bookings', audit.booking_id), 'AUDIT_ORPHAN');
  for (const recipient of data.notification_recipients) requireInvariant(find('notifications', recipient.notification_id), 'RECIPIENT_ORPHAN');
  for (const notification of data.notifications) {
    requireInvariant(data.notification_outbox.filter(row => row.event_key === notification.event_key && id(row.notification_id) === id(notification._id)).length === 1, 'EVENT_OUTBOX');
    if (/^(BOOKING_CREATED|BOOKING_CANCELLED|PT_BOOKING_COMPLETED):/.test(notification.event_key)) {
      requireInvariant(find('pt_bookings', notification.event_key.split(':')[1]), 'EVENT_BOOKING_ORPHAN');
      requireInvariant(data.notification_recipients.filter(row => id(row.notification_id) === id(notification._id)).length === 2, 'EVENT_RECIPIENTS');
    }
  }
  for (const job of data.notification_outbox) requireInvariant(find('notifications', job.notification_id), 'OUTBOX_ORPHAN');
  for (const operation of data.operation_requests) {
    if (operation.result_ids?.bookingId) requireInvariant(find('pt_bookings', operation.result_ids.bookingId), 'OPERATION_BOOKING_ORPHAN');
    if (operation.result_ids?.trainerId) requireInvariant(find('trainers', operation.result_ids.trainerId), 'OPERATION_TRAINER_ORPHAN');
    if (operation.result_ids?.sessionId) requireInvariant(find('public_sessions', operation.result_ids.sessionId), 'OPERATION_CLASS_ORPHAN');
  }
  return {
    scheduleGuard: String((await db.collection('schedule_guards').findOne({ _id: 'global' as unknown as import('mongodb').ObjectId }))?.revision),
    memberRevisions: data.members.map(row => ({ id: id(row._id), revision: String(row.service_revision) })),
    counts: Object.fromEntries(names.map(name => [name, data[name].length])), quota,
    trainers: data.trainers.map(row => ({ id: id(row._id), accountId: id(row.account_id), status: row.status, version: row.version })),
    trainerAudits: data.trainer_events.map(row => ({ trainerId: id(row.trainer_id), action: row.action,
      beforeVersion: row.before?.version, afterVersion: row.after.version, requestKey: row.request_key })),
    bookings: bookings.map(row => ({ id: id(row._id), memberId: id(row.member_id), membershipId: id(row.membership_id),
      trainerId: id(row.trainer_id), shiftId: id(row.shift_id), status: row.status, version: row.version,
      startAt: row.start_at.toISOString(), endAt: row.end_at.toISOString(), completionRevision: row.completion_revision ?? 0 })),
    shifts: data.work_shifts.map(row => ({ id: id(row._id), trainerId: id(row.trainer_id), status: row.status,
      version: row.version, startAt: row.start_at.toISOString(), endAt: row.end_at.toISOString() })),
    classes: data.public_sessions.map(row => ({ id: id(row._id), trainerId: id(row.trainer_id), status: row.status,
      version: row.version, startAt: row.start_at.toISOString(), endAt: row.end_at.toISOString() })),
    classAudits: data.public_session_events.map(row => ({ sessionId: id(row.session_id), action: row.action,
      beforeVersion: row.before?.version, afterVersion: row.after.version, requestKey: row.request_key })),
    events: data.notifications.map(row => ({ id: id(row._id), eventKey: row.event_key })),
    audits: data.booking_events.map(row => ({ bookingId: id(row.booking_id), action: row.action, requestKey: row.request_key,
      beforeStatus: row.before_status, afterStatus: row.after_status, usedBefore: row.used_before, usedAfter: row.used_after })),
    operations: data.operation_requests.map(row => ({ actorId: id(row.actor_id), operation: row.operation, key: row.client_key, status: row.response_status,
      responseHash: createHash('sha256').update(JSON.stringify(row.response_body)).digest('hex') })),
    invariants: 'PASSED',
  };
}

// Diagnostic fallback must still expose committed state when an invariant itself fails.
export async function captureFailure(db: Db) {
  const names = ['trainers', 'trainer_events', 'pt_bookings', 'memberships', 'service_sales', 'work_shifts', 'public_sessions', 'public_session_events', 'booking_events', 'operation_requests',
    'notifications', 'notification_recipients', 'notification_outbox'];
  const projection = Object.fromEntries(['_id', 'member_id', 'membership_id', 'trainer_id', 'shift_id', 'start_at', 'end_at', 'status', 'version',
    'sessions_used', 'service_sale_id', 'sessions_snapshot', 'start_date', 'end_date', 'event_key', 'notification_id', 'booking_id', 'action',
    'actor_id', 'operation', 'client_key', 'request_hash', 'result_ids', 'response_status'].map(field => [field, 1]));
  const rows = await Promise.all(names.map(name => db.collection(name).find({}, { projection, readConcern: { level: 'majority' } }).toArray()));
  return Object.fromEntries(names.map((name, index) => [name, rows[index]]));
}
