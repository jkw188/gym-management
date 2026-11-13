import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { CatalogError, catalogError, PlanForm } from './PlanForm';
import { PlanPicker, PolicyForm } from './PolicyForm';
import { formatVnd, plansApi, type CatalogPage, type Plan, type PlanPolicy, type PlansQuery } from './plans.api';
import { Icon } from '../../components/Icon';

export function PlansPage() {
  const [tab, setTab] = useState<'plans' | 'policies'>('plans');
  const [query, setQuery] = useState<PlansQuery>({ page: 1, limit: 20 });
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [policyPage, setPolicyPage] = useState(1);
  const [plans, setPlans] = useState<CatalogPage<Plan>>();
  const [policies, setPolicies] = useState<CatalogPage<PlanPolicy>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [revision, setRevision] = useState(0);
  const [editingPlan, setEditingPlan] = useState<Plan | 'new'>();
  const [editingPolicy, setEditingPolicy] = useState<PlanPolicy | 'new'>();
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(null);
    const task = tab === 'plans' ? plansApi.list(query, controller.signal).then(data => { if (!controller.signal.aborted) setPlans(data); })
      : plansApi.policies({ page: policyPage, limit: 20, fromPlanId: from || undefined }, controller.signal).then(data => { if (!controller.signal.aborted) setPolicies(data); });
    task.catch(failure => { if (!controller.signal.aborted) setError(catalogError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tab, query, policyPage, from, revision]);
  function saved() { setEditingPlan(undefined); setEditingPolicy(undefined); setNotice('Đã lưu danh mục.'); setRevision(value => value + 1); }
  const formOpen = Boolean(editingPlan || editingPolicy);
  const result = tab === 'plans' ? plans : policies;
  const page = tab === 'plans' ? query.page : policyPage;
  function go(next: number) { if (tab === 'plans') setQuery({ ...query, page: next }); else setPolicyPage(next); }
  return <section className="auth-card plans-page"><h2>Danh mục gói tập và PT</h2>
    <p className="user-notice">Thay đổi danh mục chỉ áp dụng cho lần bán mới. Giao dịch đã tạo giữ nguyên giá và quyền lợi đã chụp.</p>
    <div className="user-actions" role="tablist" aria-label="Danh mục dịch vụ">
      <button role="tab" aria-selected={tab === 'plans'} disabled={formOpen} onClick={() => setTab('plans')}>Gói tập</button>
      <button role="tab" aria-selected={tab === 'policies'} disabled={formOpen} onClick={() => setTab('policies')}>Chuyển đổi</button></div>
    {notice && <p role="status">{notice}</p>}
    {editingPlan && <PlanForm key={editingPlan === 'new' ? 'new' : editingPlan.id} initial={editingPlan === 'new' ? undefined : editingPlan} onClose={() => setEditingPlan(undefined)} onSaved={saved} />}
    {editingPolicy && <PolicyForm key={editingPolicy === 'new' ? 'new-policy' : editingPolicy.id} initial={editingPolicy === 'new' ? undefined : editingPolicy} onClose={() => setEditingPolicy(undefined)} onSaved={saved} />}
    {!formOpen && <>
      {tab === 'plans' ? <><form className="users-filter toolbar" onSubmit={event => { event.preventDefault(); setQuery({ ...query, q, page: 1 }); }}>
        <div className="toolbar-search"><label htmlFor="plans-search">Tìm mã hoặc tên gói</label><input id="plans-search" maxLength={120} value={q} onChange={e => setQ(e.target.value)} /></div>
        <div><label htmlFor="plans-kind">Lọc loại gói</label><select id="plans-kind" value={query.kind ?? ''} onChange={e => setQuery({ ...query, kind: e.target.value, page: 1 })}><option value="">Tất cả</option><option value="GYM">GYM</option><option value="PT">PT</option></select></div>
          <div><label htmlFor="plans-status">Lọc trạng thái</label><select id="plans-status" value={query.status ?? ''} onChange={e => setQuery({ ...query, status: e.target.value, page: 1 })}><option value="">Tất cả</option><option value="ACTIVE">Đang bán</option><option value="INACTIVE">Ngừng bán</option></select></div>
        <button type="submit"><Icon name="search" label="Tìm kiếm" /></button></form><button onClick={() => { setNotice(''); setEditingPlan('new'); }}>Tạo gói</button></>
        : <><PlanPicker label="Lọc gói nguồn" value={from} onChange={id => { setFrom(id); setPolicyPage(1); }} />
          <div className="user-actions"><button onClick={() => { setFrom(''); setPolicyPage(1); }}>Tất cả chính sách</button><button onClick={() => { setNotice(''); setEditingPolicy('new'); }}>Tạo chính sách</button></div></>}
      {loading && <p role="status">Đang tải danh mục…</p>}
      <CatalogError error={error} />{error && <button onClick={() => setRevision(value => value + 1)}><Icon name="retry" label="Thử lại" /></button>}
      {!loading && !error && <>
        {result?.items.length === 0 && <p>Chưa có dữ liệu phù hợp.</p>}
        {tab === 'plans' && Boolean(plans?.items.length) && <div className="users-table-wrap"><table className="users-table"><caption>Danh sách gói</caption><thead><tr><th>Mã / tên</th><th>Loại</th><th>Thời hạn / quota</th><th>Giá VND</th><th>Quyền lợi</th><th>Trạng thái</th><th>Thao tác</th></tr></thead>
          <tbody>{plans?.items.map(plan => <tr key={plan.id}><td>{plan.code}<br />{plan.name}</td><td>{plan.kind}</td><td>{plan.durationDays} ngày{plan.kind === 'PT' ? ` / ${plan.sessionsQuota} buổi` : ' / quota 0'}</td><td>{formatVnd(plan.price)}</td><td className="plan-benefits">{plan.benefits}</td><td>{plan.status === 'ACTIVE' ? 'Đang bán' : 'Ngừng bán'}</td><td><button onClick={() => { setNotice(''); setEditingPlan(plan); }}>Sửa / đổi trạng thái {plan.code}</button></td></tr>)}</tbody></table></div>}
        {tab === 'policies' && Boolean(policies?.items.length) && <div className="users-table-wrap"><table className="users-table"><caption>Chính sách chuyển đổi</caption><thead><tr><th>Gói nguồn → đích</th><th>Công thức / ghi chú</th><th>Trạng thái</th><th>Phiên bản</th><th>Thao tác</th></tr></thead><tbody>
          {policies?.items.map(policy => <tr key={policy.id}><td>{policy.fromPlanId} → {policy.toPlanId}<small>ID: {policy.id}</small></td><td>{policy.ruleCode}<br />{policy.note}</td><td>{policy.status === 'ACTIVE' ? 'Đang áp dụng' : 'Ngừng áp dụng'}</td><td>{policy.version}</td><td><button onClick={() => setEditingPolicy(policy)}>Sửa chính sách {policy.id}</button></td></tr>)}
        </tbody></table></div>}
        <div className="user-actions"><button disabled={page <= 1} onClick={() => go(page - 1)}><Icon name="prev" label="Trang trước" /></button><span>Trang {page} / {result?.totalPages ?? 0} — {result?.total ?? 0} kết quả</span><button disabled={!result || page >= result.totalPages} onClick={() => go(page + 1)}><Icon name="next" label="Trang sau" /></button></div>
      </>}
    </>}
  </section>;
}
