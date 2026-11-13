import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { membersApi, type MemberMembership, type MemberPage, type MemberTransaction } from './members.api';
import { MemberReadTime, membershipStateNames } from './MemberEntitlements';
import { Icon } from '../../components/Icon';

const transactionStatusNames = { PENDING: 'Chờ thanh toán / chưa cấp gói', SETTLED: 'Đã đối chiếu giao dịch', CANCELLED: 'Đã hủy' };
const storedStatusNames = { ACTIVE: 'Đang được ghi nhận', SUPERSEDED: 'Đã được thay thế', CANCELLED: 'Đã hủy' };

export function MemberHistory({ id }: { id: string }) {
  const [tab, setTab] = useState<'memberships' | 'transactions'>('memberships');
  return <section><h3>Gói tập và giao dịch</h3>
    <div className="user-actions" role="group" aria-label="Chọn lịch sử">
      <button type="button" aria-pressed={tab === 'memberships'} onClick={() => setTab('memberships')}>Lịch sử gói</button>
      <button type="button" aria-pressed={tab === 'transactions'} onClick={() => setTab('transactions')}>Lịch sử giao dịch</button>
    </div>
    <HistoryPage key={`${id}:${tab}`} id={id} tab={tab} />
  </section>;
}

function HistoryPage({ id, tab }: { id: string; tab: 'memberships' | 'transactions' }) {
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<MemberPage<MemberMembership | MemberTransaction> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    const call = tab === 'memberships' ? membersApi.memberships(id, page, controller.signal) : membersApi.transactions(id, page, controller.signal);
    call.then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof ApiError ? cause.message : 'Không tải được lịch sử.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, tab, page, reload]);
  return <div aria-busy={loading}>
    {loading && <p role="status">Đang tải lịch sử…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setReload(value => value + 1)}>Thử lại lịch sử</button></div>}
    {data && <><MemberReadTime time={data} />
      {!data.items.length && <p>{data.total > 0 ? 'Trang này không có dữ liệu. Chọn trang trước hoặc tải lại.'
        : tab === 'memberships' ? 'Chưa có gói tập được cấp. Giao dịch chờ thanh toán chưa cấp gói.' : 'Chưa có giao dịch.'}</p>}
      <ul>{data.items.map(item => 'membershipId' in item ? <li key={item.membershipId}>
        <strong>{item.planName} ({item.kind})</strong><p>{item.startDate} → {item.endDate}</p>
        <p>{item.timeState === 'NONE' ? 'Không cấp quyền hiện tại' : membershipStateNames[item.timeState]}
          {' · '}{storedStatusNames[item.storedStatus]} · {transactionStatusNames[item.transactionStatus]}</p>
        {item.kind === 'PT' && <p>Buổi đã dùng: {item.sessionsUsed}/{item.sessionsQuota}</p>}
        <small>Mã lần bán: {item.saleId}</small>
      </li> : <li key={item.id}>
        <strong>{item.code} ({item.kind})</strong><p>{item.kind === 'RETAIL' && item.status === 'PENDING' ? 'Chờ thanh toán' : transactionStatusNames[item.status]}</p>
        <p>Cần thu: {item.amountDue} VND · {new Date(item.createdAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</p>
        <p>{item.paymentId ? `Khoản thu đã xác nhận: ${item.paymentId}` : 'Chưa có khoản thu đã xác nhận.'}</p>
        <p>{item.invoiceId ? `Mã chứng từ: ${item.invoiceId}` : 'Chưa có chứng từ.'}</p>
      </li>)}</ul>
      <div className="user-actions"><button type="button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><Icon name="prev" label="Lịch sử trước" /></button>
        <span>Trang {data.page}/{data.totalPages} · {data.total} bản ghi</span>
        <button type="button" disabled={page >= data.totalPages} onClick={() => setPage(value => value + 1)}><Icon name="next" label="Lịch sử sau" /></button>
        <button type="button" onClick={() => setReload(value => value + 1)}><Icon name="retry" label="Tải lại lịch sử" showLabel /></button></div>
    </>}
  </div>;
}
