import { ApplicationError } from '../../common/errors/application-error';
import { normalizeVnd } from '../../common/utils/vnd-money';
import { PaymentReviewDto } from './payment-review.dto';

export interface NormalizedPaymentReview {
  method: 'CASH' | 'TRANSFER'; amount: string; evidenceNote: string;
  receivingAccountCode?: string; bankReference?: string; reference?: string; receivedAt?: Date;
}

// No CASH reference or paidAt is produced during preview. US-22 must generate those on confirmation.
export function normalizePaymentReview(input: PaymentReviewDto, createdAt: Date, now: Date): NormalizedPaymentReview {
  const normalized = normalizePaymentIntent(input);
  if (normalized.receivedAt && (normalized.receivedAt > now || normalized.receivedAt < createdAt)) {
    throw invalid('Thời điểm báo có phải từ lúc tạo giao dịch đến hiện tại');
  }
  return normalized;
}

// Stable input for idempotency: no current state/config/date check before replaying a committed command.
export function normalizePaymentIntent(input: PaymentReviewDto): NormalizedPaymentReview {
  const base = { method: input.method, amount: normalizeVnd(input.amount), evidenceNote: input.evidenceNote.trim() };
  if (base.evidenceNote.length < 10 || base.evidenceNote.length > 500) throw invalid('Căn cứ phải dài từ 10 đến 500 ký tự');
  if (input.method === 'CASH') {
    if (input.receivingAccountCode !== undefined || input.bankReference !== undefined || input.receivedAt !== undefined) {
      throw invalid('Tiền mặt không nhận tài khoản, tham chiếu hoặc thời điểm thu từ client');
    }
    return base;
  }
  if (input.method !== 'TRANSFER' || !input.receivingAccountCode || !input.bankReference?.trim() || !input.receivedAt) {
    throw invalid('Chuyển khoản cần tài khoản nhận, tham chiếu ngân hàng và thời điểm báo có');
  }
  const bankReference = input.bankReference.trim();
  const reference = `TRF:${input.receivingAccountCode}:${bankReference}`;
  if (reference.length > 100) throw invalid('Tham chiếu chuẩn hóa không được quá 100 ký tự');
  const receivedAt = new Date(input.receivedAt);
  if (!Number.isFinite(receivedAt.getTime())) throw invalid('Thời điểm báo có không hợp lệ');
  return { ...base, receivingAccountCode: input.receivingAccountCode, bankReference, reference, receivedAt };
}

export function paymentReviewResult(amountDue: string, input: NormalizedPaymentReview, blockers: string[], asOf: Date) {
  const mismatch = input.amount !== amountDue;
  const blockingCodes = [...new Set([...blockers, ...(mismatch ? ['AMOUNT_MISMATCH'] : [])])];
  const reviewState = blockers.length ? 'BLOCKED' : mismatch ? 'NEEDS_REVIEW' : 'READY';
  return { canConfirm: reviewState === 'READY', reviewState, blockingCodes, amountDue,
    ...(input.reference ? { normalizedReference: input.reference } : {}), asOf: asOf.toISOString() };
}

function invalid(message: string) { return new ApplicationError(400, 'VALIDATION_ERROR', message); }
