import Decimal from 'decimal.js';
import { Types } from 'mongoose';
import { ApplicationError } from '../errors/application-error';

const VND_MAX = '999999999999';
const VndDecimal = Decimal.clone({ precision: 30 });

// Only strings cross the API boundary. Decimal arithmetic never passes through Number.
export function normalizeVnd(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw invalidMoney();
  const amount = new VndDecimal(value);
  if (amount.gt(VND_MAX)) throw invalidMoney();
  return amount.toFixed(0);
}

export function toVndDecimal(value: unknown): Types.Decimal128 {
  return Types.Decimal128.fromString(normalizeVnd(value));
}

export function fromVndDecimal(value: Types.Decimal128): string {
  const amount = new VndDecimal(value.toString());
  if (!amount.isFinite() || !amount.isInteger() || amount.isNegative() || amount.gt(VND_MAX)) throw invalidMoney();
  return amount.toFixed(0);
}

export function addVnd(left: string, right: string): string {
  return normalizeVnd(new VndDecimal(normalizeVnd(left)).plus(normalizeVnd(right)).toFixed(0));
}

export function subtractVnd(left: string, right: string): string {
  return normalizeVnd(new VndDecimal(normalizeVnd(left)).minus(normalizeVnd(right)).toFixed(0));
}

// Zero-cost sales have no SUCCEEDED payment. The sale service must validate their policy separately.
export function assertPaymentAmount(amount: unknown, amountDue: string): string {
  const normalized = normalizeVnd(amount);
  if (normalized === '0') throw new ApplicationError(400, 'PAYMENT_AMOUNT_INVALID', 'Số tiền thu phải lớn hơn 0');
  if (normalized !== normalizeVnd(amountDue)) throw new ApplicationError(409, 'AMOUNT_MISMATCH', 'Số tiền thu phải bằng số tiền phải trả');
  return normalized;
}

function invalidMoney() {
  return new ApplicationError(400, 'VALIDATION_ERROR', 'Tiền VND phải là chuỗi số nguyên từ 0 đến 999999999999');
}
