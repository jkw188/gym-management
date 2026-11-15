import Decimal from 'decimal.js';
import { ApplicationError } from '../../common/errors/application-error';
import { addCalendarDays, assertBusinessDate } from '../../common/utils/business-date';
import { normalizeVnd } from '../../common/utils/vnd-money';

const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const DAY_MS = 86400000;
export interface UpgradeValuation {
  baseValue: string; totalDays: number; remainingDays: number; rawCredit: string; appliedCredit: string;
  excessCredit: string; amountDue: string; asOfDate: string; quoteExpiresAt: string;
}
export interface UpgradeQuote extends UpgradeValuation {
  sourceMembershipId: string; sourceVersion: number; previousSaleId: string; sourceEndDate: string;
  targetPlanId: string; targetPlanVersion: number; policyId: string; policyVersion: number;
  targetListPrice: string; targetDurationDays: number; targetSessions: number;
  quotaSummary: { used: number; reserved: number; requiredSessions: number; targetSessions: number };
}
export function readUpgradeQuote(snapshot: string): UpgradeQuote | null {
  try {
    const data = JSON.parse(snapshot) as { rule?: unknown; quote?: UpgradeQuote };
    const q = data?.quote;
    if (data?.rule !== 'UPGRADE_V1' || !q || typeof q.asOfDate !== 'string' || typeof q.quoteExpiresAt !== 'string' ||
      !['baseValue', 'rawCredit', 'appliedCredit', 'excessCredit', 'amountDue', 'targetListPrice'].every(field =>
        typeof q[field as keyof UpgradeQuote] === 'string' && /^\d+$/.test(String(q[field as keyof UpgradeQuote])))) return null;
    return q;
  } catch { return null; }
}
export function valueUpgrade(input: { startDate: string; endDate: string; asOfDate: string;
  sourceAmountDue: string; sourceCredit: string; targetListPrice: string }): UpgradeValuation {
  const start = assertBusinessDate(input.startDate), end = assertBusinessDate(input.endDate), today = assertBusinessDate(input.asOfDate);
  const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  const totalDays = days(start, end), remainingDays = Math.max(0, days(today, end));
  if (totalDays < 1 || today < start || remainingDays > totalDays) throw new ApplicationError(409, 'SOURCE_NOT_CURRENT', 'Kỳ nguồn không hiện hành');
  const baseValue = normalizeVnd(new Money(normalizeVnd(input.sourceAmountDue)).plus(normalizeVnd(input.sourceCredit)).toFixed(0));
  const raw = new Money(baseValue).times(remainingDays).div(totalDays).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const list = new Money(normalizeVnd(input.targetListPrice)), applied = Money.min(raw, list);
  return { baseValue, totalDays, remainingDays, rawCredit: raw.toFixed(0), appliedCredit: applied.toFixed(0),
    excessCredit: raw.minus(applied).toFixed(0), amountDue: list.minus(applied).toFixed(0), asOfDate: today,
    quoteExpiresAt: new Date(`${addCalendarDays(today, 1)}T00:00:00+07:00`).toISOString() };
}
