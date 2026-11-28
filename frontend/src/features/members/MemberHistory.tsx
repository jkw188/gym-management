import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { membersApi, type MemberMembership, type MemberPage, type MemberTransaction } from './members.api';
import { MemberReadTime, membershipStateNames } from './MemberEntitlements';
import { Icon } from '../../components/Icon';
import { ServiceRenewalPanel } from '../sales/ServiceRenewalPanel';
import { ServiceUpgradePanel } from '../sales/ServiceUpgradePanel';
import { formatVnd } from '../../utils/money';

const transactionStatusNames = { PENDING: 'Chờ thanh toán / chưa cấp gói', SETTLED: 'Đã đối chiếu giao dịch', CANCELLED: 'Đã hủy' };
const storedStatusNames = { ACTIVE: 'Đang được ghi nhận', SUPERSEDED: 'Đã được thay thế', CANCELLED: 'Đã hủy' };

type HistoryTab = 'memberships' | 'transactions';

export function MemberHistory({ id, tab, revision = 0, onUpdated }: {
  id: string; tab: HistoryTab | null; revision?: number; onUpdated?: () => void;
}) {
  const [source, setSource] = useState<MemberMembership | null>(null);
  const [renewalLocked, setRenewalLocked] = useState(false);
  const [upgradeSource, setUpgradeSource] = useState<MemberMembership | null>(null);
  const [upgradeLocked, setUpgradeLocked] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  function refresh() { setRefreshes(value => value + 1); onUpdated?.(); }
  return <>
    <section className="gm-panel gm-profile-panel" id="gm-member-panel-memberships" role="tabpanel" hidden={tab !== 'memberships'}
      aria-labelledby="gm-member-tab-memberships" tabIndex={0}>
      <HistoryPage id={id} tab="memberships" active={tab === 'memberships'} revision={revision + refreshes}
        onRenew={value => { setUpgradeSource(null); setSource(value); }}
        onUpgrade={value => { setSource(null); setUpgradeSource(value); }} renewalLocked={renewalLocked || upgradeLocked} />
      <ServiceRenewalPanel key={id} memberId={id} source={source} onLockedChange={setRenewalLocked} onRefresh={refresh} />
      <ServiceUpgradePanel key={id} memberId={id} source={upgradeSource} onLockedChange={setUpgradeLocked} onRefresh={refresh} />
    </section>
    <section className="gm-panel gm-profile-panel" id="gm-member-panel-transactions" role="tabpanel" hidden={tab !== 'transactions'}
      aria-labelledby="gm-member-tab-transactions" tabIndex={0}>
      <HistoryPage id={id} tab="transactions" active={tab === 'transactions'} revision={revision + refreshes} />
      <p>Để xử lý giao dịch gói đang chờ, mở Đăng ký gói và chọn giao dịch theo mã.</p>
    </section>
  </>;
}

function HistoryPage({ id, tab, active, revision, onRenew, onUpgrade, renewalLocked }: { id: string; tab: HistoryTab;
  active: boolean; revision: number; onRenew?: (source: MemberMembership) => void; onUpgrade?: (source: MemberMembership) => void;
  renewalLocked?: boolean }) {
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<MemberPage<MemberMembership | MemberTransaction> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    const call = tab === 'memberships' ? membersApi.memberships(id, page, controller.signal) : membersApi.transactions(id, page, controller.signal);
    call.then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof ApiError ? cause.message : 'Không tải được lịch sử.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, tab, page, reload, active, revision]);
  return <div aria-busy={loading}>
    {loading && <p role="status">Đang tải lịch sử…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setReload(value => value + 1)}>Thử lại lịch sử</button></div>}
    {data && <><MemberReadTime time={data} />
      {!data.items.length && <p>{data.total > 0 ? 'Trang này không có dữ liệu. Chọn trang trước hoặc tải lại.'
        : tab === 'memberships' ? 'Chưa có gói tập được cấp. Giao dịch chờ thanh toán chưa cấp gói.' : 'Chưa có giao dịch.'}</p>}
      {!!data.items.length && <ul className="gm-history-list">{data.items.map(item => 'membershipId' in item ? <li key={item.membershipId}>
        <strong>{item.planName} ({item.kind})</strong><p>{item.startDate} → {item.endDate}</p>
        <p>{item.timeState === 'NONE' ? 'Không cấp quyền hiện tại' : membershipStateNames[item.timeState]}
          {' · '}{storedStatusNames[item.storedStatus]} · {transactionStatusNames[item.transactionStatus]}</p>
        {item.kind === 'PT' && <p>Buổi đã dùng: {item.sessionsUsed}/{item.sessionsQuota}</p>}
        <small>Mã lần bán: {item.saleId}</small>
        {item.storedStatus === 'ACTIVE' && item.transactionStatus === 'SETTLED' &&
          <button type="button" disabled={renewalLocked} onClick={() => onRenew?.(item)}>Gia hạn {item.planName}</button>}
        {item.storedStatus === 'ACTIVE' && item.transactionStatus === 'SETTLED' && item.timeState === 'CURRENT' &&
          <button type="button" disabled={renewalLocked} onClick={() => onUpgrade?.(item)}>Nâng cấp {item.planName}</button>}
      </li> : <li key={item.id}>
        <strong>{item.code} ({item.kind})</strong><p>{item.kind === 'RETAIL' && item.status === 'PENDING' ? 'Chờ thanh toán' : transactionStatusNames[item.status]}</p>
        <p>Cần thu: {formatVnd(item.amountDue)} · {new Date(item.createdAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</p>
        <p>{item.paymentId ? `Khoản thu đã xác nhận: ${item.paymentId}` : 'Chưa có khoản thu đã xác nhận.'}</p>
        <p>{item.invoiceId ? `Mã chứng từ: ${item.invoiceId}` : 'Chưa có chứng từ.'}</p>
      </li>)}</ul>}
      <div className="gm-pagination"><button type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><Icon name="prev" label="Lịch sử trước" /></button>
        <span>Trang {data.totalPages === 0 ? '0' : data.page}/{data.totalPages} · {data.total} bản ghi</span>
        <button type="button" disabled={page >= data.totalPages} onClick={() => setPage(value => value + 1)}><Icon name="next" label="Lịch sử sau" /></button>
        <button type="button" onClick={() => setReload(value => value + 1)}><Icon name="retry" label="Tải lại lịch sử" showLabel /></button></div>
    </>}
  </div>;
}
