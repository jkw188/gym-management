import { ObjectId } from 'mongodb';
import { ApplicationError, invalidField } from '../../common/errors/application-error';
import { addCalendarDays, assertBusinessDate } from '../../common/utils/business-date';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { Types } from 'mongoose';
import { CashFlowQueryDto } from './cash-flow.dto';
import { CashFlowSources, CashSource } from './cash-flow.repository';

export const CASH_KINDS = ['GYM', 'PT', 'RETAIL', 'UNKNOWN'] as const;
export const CASH_METHODS = ['CASH', 'TRANSFER', 'UNKNOWN'] as const;
type Kind = typeof CASH_KINDS[number];
type Method = typeof CASH_METHODS[number];
export interface CashEvent {
  eventId: string; id: string; eventType: 'RECEIPT' | 'REFUND'; occurredAt: string | null;
  amount: string | null; kind: Kind; method: Method; status: string;
  paymentId: string | null; refundId: string | null; transactionId: string | null; transactionCode: string | null;
  orderId: string | null; orderCode: string | null; returnId: string | null; invoiceId: string | null; invoiceCode: string | null;
  lateReceipt: boolean; warningCodes: string[];
}
const DAY = 86400000;
const id = (value: unknown) => value instanceof ObjectId ? value.toHexString() : null;
export const vnDate = (date: Date) => new Date(date.getTime() + 7 * 3600000).toISOString().slice(0, 10);
export function cashRange(query: CashFlowQueryDto, observedAt: Date) {
  const today = vnDate(observedAt);
  const fromDate = assertBusinessDate(query.fromDate ?? `${today.slice(0, 7)}-01`);
  const toDate = assertBusinessDate(query.toDate ?? today);
  const start = new Date(`${fromDate}T00:00:00+07:00`).getTime();
  const end = new Date(`${toDate}T00:00:00+07:00`).getTime() + DAY;
  if (fromDate > toDate || toDate > today || (end - start) / DAY > 366) invalidField('fromDate', 'Kỳ phải đúng thứ tự, tối đa 366 ngày và không sau hôm nay VN');
  return { fromDate, toDate, timezone: 'Asia/Ho_Chi_Minh', start: new Date(start).toISOString(),
    endExclusive: new Date(end).toISOString(), effectiveTo: new Date(Math.min(end, observedAt.getTime())).toISOString(),
    isOngoing: toDate === today };
}
function amount(value: unknown): bigint | null {
  if (!(value instanceof Types.Decimal128)) return null;
  try { const result = BigInt(fromVndDecimal(value)); return result > 0n ? result : null; } catch { return null; }
}
function date(value: unknown): Date | null { return value instanceof Date && Number.isFinite(value.getTime()) ? value : null; }
function bucket() { return { receipt: 0n, refund: 0n, badReceipt: false, badRefund: false }; }
type Bucket = ReturnType<typeof bucket>;
function view(b: Bucket) {
  const knownTotals = { grossReceipts: String(b.receipt), refundPaid: String(b.refund), netCash: String(b.receipt - b.refund) };
  return { totals: { grossReceipts: b.badReceipt ? null : knownTotals.grossReceipts,
    refundPaid: b.badRefund ? null : knownTotals.refundPaid, netCash: b.badReceipt || b.badRefund ? null : knownTotals.netCash },
    knownTotals: { label: b.badReceipt || b.badRefund ? 'PARTIAL' as const : 'COMPLETE' as const, ...knownTotals } };
}

export function resolveCashFlow(sources: CashFlowSources, query: CashFlowQueryDto, observedAt: Date) {
  const range = cashRange(query, observedAt), start = Date.parse(range.start), end = Date.parse(range.endExclusive);
  const payments = new Map(sources.payments.map(row => [id(row._id), row]));
  const transactions = new Map(sources.transactions.map(row => [id(row._id), row]));
  const orders = new Map(sources.orders.map(row => [id(row.transaction_id), row]));
  const invoices = new Map(sources.invoices.map(row => [id(row.transaction_id), row]));
  const total = bucket(), kinds = Object.fromEntries(CASH_KINDS.map(k => [k, bucket()])) as Record<Kind, Bucket>;
  const methods = { RECEIPT: Object.fromEntries(CASH_METHODS.map(k => [k, bucket()])) as Record<Method, Bucket>,
    REFUND: Object.fromEntries(CASH_METHODS.map(k => [k, bucket()])) as Record<Method, Bucket> };
  const days = new Map<string, Bucket>();
  for (let day = range.fromDate; day <= range.toDate; day = addCalendarDays(day, 1)) days.set(day, bucket());
  const invalid = new Set<string>(), warnings = new Set<string>(), events: CashEvent[] = [];
  let outstanding = 0n, outstandingCount = 0, badOutstanding = false, badOutstandingCount = false, knownCount = 0;
  const warn = (key: string, codes: string[]) => { if (codes.length) { invalid.add(key); codes.forEach(code => warnings.add(code)); } };

  function source(row: CashSource, eventType: CashEvent['eventType']) {
    const payment = eventType === 'RECEIPT' ? row : payments.get(id(row.payment_id));
    const transaction = payment?.transaction_id ? transactions.get(id(payment.transaction_id)) : undefined;
    const kind: Kind = transaction && ['GYM', 'PT', 'RETAIL'].includes(transaction.kind ?? '') ? transaction.kind as Kind : 'UNKNOWN';
    const method: Method = CASH_METHODS.includes(row.method as Method) && row.method !== 'UNKNOWN' ? row.method as Method : 'UNKNOWN';
    const codes: string[] = [];
    if (!payment || !transaction || kind === 'UNKNOWN') codes.push('SOURCE_KIND_UNKNOWN');
    const value = amount(row.amount);
    if (value === null) codes.push('INVALID_AMOUNT');
    return { payment, transaction, kind, method, codes, value };
  }
  function accept(row: CashSource, eventType: CashEvent['eventType']) {
    const s = source(row, eventType), { payment, transaction, kind, method, codes, value } = s;
    if (query.kind !== 'ALL' && kind !== 'UNKNOWN' && kind !== query.kind) return;
    const occurred = date(eventType === 'RECEIPT' ? row.paid_at : row.refunded_at);
    if (occurred && (occurred.getTime() < start || occurred.getTime() >= end || occurred > observedAt)) return;
    const selectedMethod = eventType === 'RECEIPT' ? query.paymentMethod : query.payoutMethod;
    if (selectedMethod !== 'ALL' && method !== 'UNKNOWN' && method !== selectedMethod) return;
    if (!occurred) codes.push('EVENT_TIMESTAMP_INVALID');
    if (method === 'UNKNOWN') codes.push(eventType === 'REFUND' ? 'PAYOUT_METHOD_UNKNOWN' : 'PAYMENT_METHOD_UNKNOWN');
    const eventId = `${eventType}:${row._id}`;
    warn(eventId, codes);
    const certain = value !== null && occurred !== null && kind !== 'UNKNOWN' && (method !== 'UNKNOWN' || selectedMethod === 'ALL');
    const canAdd = value !== null && occurred !== null && (query.kind === 'ALL' || kind === query.kind) && (selectedMethod === 'ALL' || method === selectedMethod);
    if (certain) knownCount++;
    function accumulate(b: Bucket, add: boolean) {
      if (canAdd && add) b[eventType === 'RECEIPT' ? 'receipt' : 'refund'] += value!;
      if (!certain) b[eventType === 'RECEIPT' ? 'badReceipt' : 'badRefund'] = true;
    }
    accumulate(total, true);
    for (const k of CASH_KINDS) if (kind === k || kind === 'UNKNOWN') accumulate(kinds[k], kind === k);
    for (const m of CASH_METHODS) if (method === m || method === 'UNKNOWN') {
      const b = methods[eventType][m];
      // UNKNOWN method still contributes to the unfiltered KPI, but cannot establish known method groups.
      accumulate(b, method === m);
      if (method === 'UNKNOWN') b[eventType === 'RECEIPT' ? 'badReceipt' : 'badRefund'] = true;
    }
    if (occurred) accumulate(days.get(vnDate(occurred))!, true);
    else for (const b of days.values()) accumulate(b, true);
    const txId = id(payment?.transaction_id), order = txId ? orders.get(txId) : undefined, invoice = txId ? invoices.get(txId) : undefined;
    events.push({ eventId, id: String(row._id), eventType, occurredAt: occurred?.toISOString() ?? null,
      amount: value === null ? null : String(value), kind, method, status: row.status!,
      paymentId: id(payment?._id) ?? (eventType === 'REFUND' ? id(row.payment_id) : null), refundId: eventType === 'REFUND' ? id(row._id) : null,
      transactionId: txId, transactionCode: transaction?.code ?? null, orderId: id(row.order_id) ?? id(order?._id),
      orderCode: order?.code ?? null, returnId: id(row.return_id), invoiceId: id(invoice?._id), invoiceCode: invoice?.invoice_no ?? null,
      lateReceipt: payment?.receipt_purpose === 'LATE_CANCELLED_ORDER', warningCodes: codes });
  }
  for (const row of sources.payments) if (row.status === 'SUCCEEDED') accept(row, 'RECEIPT');
  for (const row of sources.refunds) {
    if (row.status === 'SUCCEEDED') accept(row, 'REFUND');
    else if (row.status === 'PENDING' || row.status === 'FAILED') {
      const { kind, codes, value } = source(row, 'REFUND');
      if (query.kind !== 'ALL' && kind !== 'UNKNOWN' && kind !== query.kind) continue;
      warn(`REFUND:${row._id}`, codes);
      if (query.kind === 'ALL' || kind === query.kind) { outstandingCount++; if (value !== null) outstanding += value; }
      if (value === null || kind === 'UNKNOWN') badOutstanding = true;
      if (kind === 'UNKNOWN' && query.kind !== 'ALL') badOutstandingCount = true;
    }
  }
  events.sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? '') || a.eventType.localeCompare(b.eventType) || b.id.localeCompare(a.id));
  const quality = !invalid.size ? 'COMPLETE' : knownCount || events.length === 0 ? 'PARTIAL' : 'UNAVAILABLE';
  const summary = { range, observedAt: observedAt.toISOString(), metricVersion: 'S08-V1' as const, dataQuality: quality,
    invalidRecordCount: invalid.size, warningCodes: [...warnings].sort(), ...view(total),
    knownTotals: { ...view(total).knownTotals, label: invalid.size ? 'PARTIAL' as const : 'COMPLETE' as const },
    filter: { kind: query.kind, paymentMethod: query.paymentMethod, payoutMethod: query.payoutMethod,
      paymentMethodScope: 'RECEIPTS_ONLY', payoutMethodScope: 'SUCCEEDED_REFUNDS_ONLY' },
    byKind: Object.fromEntries(CASH_KINDS.map(k => [k, view(kinds[k])])),
    byDate: [...days].map(([day, b]) => ({ date: day, isComplete: day < vnDate(observedAt), ...view(b) })),
    byMethod: { receipts: Object.fromEntries(CASH_METHODS.map(m => [m, view(methods.RECEIPT[m])])),
      refunds: Object.fromEntries(CASH_METHODS.map(m => [m, view(methods.REFUND[m])])) },
    currentOutstandingRefunds: { scope: 'CURRENT_AT_OBSERVED_AT', dateFilterApplied: false, methodFiltersApplied: false,
      kind: query.kind, observedAt: observedAt.toISOString(), outstandingRefundAmount: badOutstanding ? null : String(outstanding),
      count: badOutstandingCount ? null : outstandingCount, knownAmount: String(outstanding), knownCount: outstandingCount,
      dataQuality: badOutstanding ? 'PARTIAL' : 'COMPLETE' } };
  return { summary, events };
}

export function requireCashEvent(events: CashEvent[], eventType: string, eventId: string) {
  const event = events.find(row => row.eventType === eventType && row.id === eventId.toLowerCase());
  if (!event) throw new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy sự kiện tiền trong kỳ và bộ lọc đã chọn');
  return event;
}
