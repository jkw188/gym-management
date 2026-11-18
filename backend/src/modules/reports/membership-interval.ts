import { addCalendarDays, assertBusinessDate } from '../../common/utils/business-date';
import { MembershipReportSources, ReportMembershipSource, ReportSaleSource } from './membership-reports.repository';

export type ReportKind = 'ALL' | 'GYM' | 'PT';
export const sourceId = (value: unknown): string | null => value && typeof value === 'object' && 'toHexString' in value &&
  typeof value.toHexString === 'function' ? value.toHexString() as string : null;
const instant = (value: unknown): number | null => value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null;
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
const day = (value: unknown, next = false): number | null => {
  try { const date = assertBusinessDate(value); return Date.parse(`${next ? addCalendarDays(date, 1) : date}T00:00:00+07:00`); }
  catch { return null; }
};
export interface MembershipSourceView {
  membershipId: string | null; serviceSaleId: string | null; transactionId: string | null;
  kind: 'GYM' | 'PT' | null; planId: string | null; planNameSnapshot: string | null;
  startDate: string | null; endDate: string | null; effectiveStart: string | null; effectiveEnd: string | null;
  currentStatus: string | null; currentTransactionStatus: string | null;
  createdAt: string | null;
  qualifies: boolean | null; reasonCodes: string[];
}

export function resolveMemberships(source: MembershipReportSources, at: number, selectedKind: ReportKind) {
  const members = new Map(source.members.map(row => [sourceId(row._id), row]));
  const sales = new Map(source.sales.map(row => [sourceId(row._id), row]));
  const transactions = new Map(source.transactions.map(row => [sourceId(row._id), row]));
  const bySale = new Map<string | null, ReportMembershipSource[]>();
  for (const row of source.memberships) {
    const key = sourceId(row.service_sale_id); bySale.set(key, [...(bySale.get(key) ?? []), row]);
  }
  const issues = new Set<string>();
  const warnings = new Set<string>();
  const uncertainKinds = new Set<string>();
  const uncertainMembers = new Map<string, Set<string>>();
  const views = new Map<string, MembershipSourceView[]>();
  const active = { GYM: new Set<string>(), PT: new Set<string>() };
  const counts = { GYM: 0, PT: 0 };
  const unknownOwnerKinds = new Set<string>();
  const totalUnknown = source.members.some(row => instant(row.created_at) === null);
  for (const row of source.members) if (instant(row.created_at) === null) {
    issues.add(`member:${sourceId(row._id)}`); warnings.add('MEMBER_CREATED_AT_MISSING');
  }
  const evaluate = (membership: ReportMembershipSource | undefined, sale: ReportSaleSource | undefined) => {
    const tx = transactions.get(sourceId(sale?.transaction_id));
    const memberId = sourceId(sale?.member_id);
    const member = members.get(memberId);
    const kind = tx?.kind === 'GYM' || tx?.kind === 'PT' ? tx.kind as 'GYM' | 'PT' : null;
    const created = instant(membership?.created_at), settled = instant(tx?.settled_at);
    const startDay = day(sale?.start_date), endDay = day(sale?.end_date, true);
    const superseded = instant(membership?.superseded_at), cancelled = instant(membership?.cancelled_at);
    const invalidSuperseded = membership?.superseded_at != null && superseded === null;
    const invalidCancelled = membership?.cancelled_at != null && cancelled === null;
    const start = startDay !== null && created !== null && settled !== null ? Math.max(startDay, created, settled) : null;
    const end = endDay === null || invalidSuperseded || invalidCancelled || membership?.status === 'SUPERSEDED' && superseded === null ||
      membership?.status === 'CANCELLED' && cancelled === null ? null : Math.min(endDay, superseded ?? Infinity, cancelled ?? Infinity);
    const reasons: string[] = [];
    if (!sale) reasons.push('SALE_MISSING');
    if (!tx) reasons.push('TRANSACTION_MISSING');
    if (!member) reasons.push('MEMBER_MISSING');
    if (!membership) reasons.push('SETTLED_MEMBERSHIP_MISSING');
    if (!kind || sale?.kind_snapshot && sale.kind_snapshot !== kind) reasons.push('KIND_INVALID');
    if (tx && sourceId(tx.member_id) !== memberId) reasons.push('MEMBER_REFERENCE_MISMATCH');
    if (created === null) reasons.push('MEMBERSHIP_CREATED_AT_MISSING');
    if (settled === null) reasons.push('SETTLED_AT_MISSING');
    if (startDay === null || endDay === null || startDay >= endDay) reasons.push('PERIOD_INVALID');
    if (membership?.status === 'SUPERSEDED' && (superseded === null || !sourceId(membership.superseded_by_membership_id))) reasons.push('SUPERSESSION_HISTORY_MISSING');
    if (membership?.status === 'CANCELLED' && cancelled === null) reasons.push('CANCELLATION_HISTORY_MISSING');
    if (invalidSuperseded) reasons.push('SUPERSESSION_HISTORY_INVALID');
    if (invalidCancelled) reasons.push('CANCELLATION_HISTORY_INVALID');
    if (membership && !['ACTIVE', 'SUPERSEDED', 'CANCELLED'].includes(membership.status ?? '')) reasons.push('MEMBERSHIP_STATUS_INVALID');
    if (tx && tx.status !== 'SETTLED') reasons.push('SETTLEMENT_NOT_PROVEN');
    if (sale && (bySale.get(sourceId(sale._id))?.length ?? 0) > 1) reasons.push('DUPLICATE_MEMBERSHIP_SALE');
    if (member && instant(member.created_at) === null) reasons.push('MEMBER_CREATED_AT_MISSING');
    // Known bounds can prove an invalid historical row irrelevant to this instant.
    const outside = [startDay, created, settled, instant(member?.created_at)].some(t => t !== null && t > at) ||
      [endDay, superseded, cancelled].some(t => t !== null && t <= at);
    const qualifies = outside ? false : reasons.length ? null : start! <= at && at < end!;
    if (qualifies === null) {
      issues.add(`${membership ? 'membership' : 'sale'}:${sourceId(membership?._id ?? sale?._id)}`);
      reasons.forEach(reason => warnings.add(reason));
      const affected = kind && !reasons.includes('KIND_INVALID') ? [kind] : ['GYM', 'PT'];
      affected.forEach(k => uncertainKinds.add(k));
      if (memberId && member) {
        const set = uncertainMembers.get(memberId) ?? new Set<string>();
        affected.forEach(k => set.add(k)); uncertainMembers.set(memberId, set);
      } else affected.forEach(k => unknownOwnerKinds.add(k));
    }
    if (qualifies && kind && memberId) { active[kind].add(memberId); counts[kind]++; }
    const view: MembershipSourceView = {
      membershipId: sourceId(membership?._id), serviceSaleId: sourceId(sale?._id), transactionId: sourceId(tx?._id), kind,
      planId: sourceId(sale?.plan_id), planNameSnapshot: sale?.plan_name_snapshot ?? null,
      startDate: sale?.start_date ?? null, endDate: sale?.end_date ?? null,
      effectiveStart: iso(start), effectiveEnd: iso(end), currentStatus: membership?.status ?? null,
      createdAt: iso(created),
      currentTransactionStatus: tx?.status ?? null, qualifies,
      reasonCodes: qualifies === null ? reasons : [qualifies ? 'EFFECTIVE_AT_AS_OF' : 'OUTSIDE_EFFECTIVE_INTERVAL'],
    };
    if (memberId) views.set(memberId, [...(views.get(memberId) ?? []), view]);
  };
  for (const membership of source.memberships) evaluate(membership, sales.get(sourceId(membership.service_sale_id)));
  for (const sale of source.sales) {
    if (!bySale.has(sourceId(sale._id)) && transactions.get(sourceId(sale.transaction_id))?.status === 'SETTLED') evaluate(undefined, sale);
  }
  const knownMembers = source.members.filter(row => instant(row.created_at) !== null && instant(row.created_at)! <= at)
    .sort((a, b) => instant(b.created_at)! - instant(a.created_at)! || sourceId(b._id)!.localeCompare(sourceId(a._id)!));
  const kinds: ('GYM' | 'PT')[] = selectedKind === 'ALL' ? ['GYM', 'PT'] : [selectedKind];
  const affected = (set: Set<string> | undefined) => kinds.some(k => set?.has(k));
  const rows = knownMembers.map(row => {
    const id = sourceId(row._id)!;
    const qualifying = (views.get(id) ?? []).filter(view => view.qualifies && view.kind && kinds.includes(view.kind));
    const unknown = affected(unknownOwnerKinds) || affected(uncertainMembers.get(id));
    return { memberId: id, code: row.member_code ?? null, displayName: row.full_name ?? null,
      linkedAccount: sourceId(row.account_id) !== null,
      qualifyingMembershipCount: unknown ? null : qualifying.length,
      activity: qualifying.length ? 'ACTIVE' : unknown ? 'UNKNOWN' : 'INACTIVE' };
  });
  const uncertain = totalUnknown || affected(uncertainKinds);
  const knownActive = rows.filter(row => row.activity === 'ACTIVE').length;
  const byKind = Object.fromEntries((['GYM', 'PT'] as const).map(k => [k, {
    activeMembers: totalUnknown || uncertainKinds.has(k) ? null : active[k].size,
    activeMemberships: totalUnknown || uncertainKinds.has(k) ? null : counts[k],
  }]));
  return { rows, views, summary: {
    dataQuality: totalUnknown ? 'UNAVAILABLE' as const : issues.size ? 'PARTIAL' as const : 'COMPLETE' as const,
    totalMembers: totalUnknown ? null : knownMembers.length,
    activeMembers: uncertain ? null : knownActive,
    inactiveMembers: uncertain ? null : knownMembers.length - knownActive,
    activeRate: uncertain || !knownMembers.length ? null : 100 * knownActive / knownMembers.length,
    activeMemberships: uncertain ? null : kinds.reduce((sum, k) => sum + counts[k], 0),
    byKind, invalidRecordCount: issues.size, warningCodes: [...warnings].sort(),
    knownTotals: { totalMembers: knownMembers.length, activeMembers: knownActive,
      activeMemberships: kinds.reduce((sum, k) => sum + counts[k], 0) },
  } };
}
