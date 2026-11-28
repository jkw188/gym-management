import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { membersApi, type MemberListItem, type MemberPage, type MembershipState } from './members.api';
import { EntitlementChips, MemberReadTime, membershipStateNames } from './MemberEntitlements';
import { Icon } from '../../components/Icon';

export function MembersPage() {
  const { pathname, search, key } = useLocation();
  const base = pathname.toLowerCase().startsWith('/admin') ? '/admin/members' : '/staff/members';
  const [params, setParams] = useSearchParams();
  const nextParams = useRef(params);
  const q = (params.get('q') ?? '').slice(0, 120);
  const kindParam = params.get('kind');
  const kind = kindParam === 'GYM' || kindParam === 'PT' ? kindParam : '';
  const stateParam = params.get('membershipState');
  const membershipState = stateParam && Object.hasOwn(membershipStateNames, stateParam) ? stateParam as MembershipState : '';
  const pageParam = Number(params.get('page'));
  const page = Number.isSafeInteger(pageParam) && pageParam > 0 ? pageParam : 1;
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<MemberPage<MemberListItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const round = useRef(0);

  useLayoutEffect(() => { nextParams.current = params; }, [params, key]);
  // Invalidate ngay khi nhập, kể cả trong khoảng debounce, không chờ request mới được gửi.
  function change(update: () => void) {
    round.current += 1; setData(null); setError(''); setLoading(true); update();
  }
  function applyParams(next: URLSearchParams) {
    // Gộp các thay đổi trước khi React Router render URL mới.
    nextParams.current = next;
    change(() => setParams(next, { replace: true }));
  }
  function setFilter(name: 'q' | 'kind' | 'membershipState', value: string) {
    const next = new URLSearchParams(nextParams.current);
    if (value) next.set(name, value);
    else next.delete(name);
    next.delete('page');
    applyParams(next);
  }
  function setPage(nextPage: number) {
    const next = new URLSearchParams(nextParams.current);
    if (nextPage > 1) next.set('page', String(nextPage));
    else next.delete('page');
    applyParams(next);
  }
  const hasFilters = !!(q || kind || membershipState);
  useEffect(() => {
    const current = ++round.current;
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    const timer = setTimeout(() => {
      membersApi.list({ q, kind, membershipState, page, limit: 20 }, controller.signal)
        .then(result => { if (round.current === current && !controller.signal.aborted) setData(result); })
        .catch(cause => {
          if (round.current === current && !controller.signal.aborted) setError(cause instanceof ApiError ? cause.message : 'Không tải được hội viên.');
        }).finally(() => { if (round.current === current && !controller.signal.aborted) setLoading(false); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q, kind, membershipState, page, reload, key]);

  return <section className="gm-members">
    <div className="gm-page-head"><div><h1>Tra cứu hội viên</h1><p>Tìm hồ sơ theo mã, họ tên hoặc số điện thoại.</p></div>
      <Link className="gm-primary" to={`${base}/new`}><Icon name="plus" />Tạo hồ sơ hội viên</Link></div>
    <div className="gm-member-total gm-panel" aria-live="polite">
      <span className="gm-icon-tile"><Icon name="users" /></span><span>Tổng hồ sơ theo bộ lọc <strong>{data?.total ?? '—'}</strong></span>
    </div>
    <section className="gm-panel gm-member-results" aria-label="Kết quả tra cứu hội viên">
    <div className="gm-filters" role="search" aria-label="Bộ lọc hội viên">
    <div className="gm-member-search"><label htmlFor="member-search">Mã, tên hoặc số điện thoại</label>
      <div><Icon name="search" /><input id="member-search" value={q} maxLength={120} placeholder="Nhập từ khóa"
        onChange={event => setFilter('q', event.target.value)} /></div></div>
    <div><label htmlFor="member-kind">Loại dịch vụ</label>
    <select id="member-kind" value={kind} onChange={event => setFilter('kind', event.target.value)}>
      <option value="">Tất cả loại</option><option value="GYM">GYM</option><option value="PT">PT</option>
    </select></div>
    <div><label htmlFor="member-state">Trạng thái gói</label>
    <select id="member-state" value={membershipState} onChange={event => setFilter('membershipState', event.target.value)}>
      <option value="">Tất cả trạng thái</option>
      {Object.entries(membershipStateNames).map(([value, label]) => <option key={value} value={value}>{value === 'NONE' ? 'Không có gói' : label}</option>)}
    </select></div>
    <button type="button" disabled={!hasFilters && page === 1} onClick={() => applyParams(new URLSearchParams())}>Xóa lọc</button>
    </div>
    {loading && <p className="gm-empty" role="status">Đang tải hội viên…</p>}
    {error && <div className="gm-empty" role="alert"><p>{error}</p>
      <button type="button" onClick={() => change(() => setReload(value => value + 1))}><Icon name="retry" label="Thử lại" showLabel /></button></div>}
    {data && <>
      {data.items.length === 0 ? <div className="gm-empty">
        <p>{hasFilters ? 'Không tìm thấy hội viên phù hợp.' : page > 1 ? 'Trang này không có hội viên.' : 'Chưa có hồ sơ hội viên.'}</p>
        {hasFilters ? <p>Sửa từ khóa hoặc chọn Xóa lọc.</p> : page === 1 &&
          <Link to={`${base}/new`}>Tạo hồ sơ đầu tiên</Link>}
      </div> : <div className="gm-table-wrap"><table className="gm-member-table" aria-label="Danh sách hội viên">
        <thead><tr><th scope="col">Mã hội viên</th><th scope="col">Họ tên</th><th scope="col">Điện thoại</th>
          <th scope="col">Tài khoản</th><th scope="col">Gói GYM</th><th scope="col">Gói PT</th><th scope="col">Thao tác</th></tr></thead>
        <tbody>{data.items.map(member => <tr key={member.id}>
          <td className="gm-member-code">{member.memberCode}</td>
          <td className="gm-member-name"><Link to={`${base}/${member.id}`} state={{ memberListSearch: search }}
            aria-label={`${member.memberCode} — ${member.fullName}`}>
            <span className="gm-avatar" aria-hidden="true">{member.fullName.trim().split(/\s+/).pop()?.charAt(0).toUpperCase()}</span>
            <strong>{member.fullName}</strong></Link></td>
          <td className="gm-member-phone">{member.phone}</td>
          <td className="gm-member-link-state"><span className="gm-chip" data-state={member.accountLinked ? 'LINKED' : 'NONE'}>
            {member.accountLinked ? 'Đã liên kết tài khoản' : 'Chưa liên kết tài khoản'}</span></td>
          <td><EntitlementChips kind="GYM" states={member.entitlementSummary.GYM} /></td>
          <td><EntitlementChips kind="PT" states={member.entitlementSummary.PT} /></td>
          <td className="gm-member-open"><Link to={`${base}/${member.id}`} state={{ memberListSearch: search }}>
            Xem hồ sơ <Icon name="next" /></Link></td>
        </tr>)}</tbody>
      </table></div>}
      <div className="gm-list-footer"><MemberReadTime time={data} />
        <div className="gm-pagination">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}><Icon name="prev" label="Trang trước" /></button>
          <span>Trang {data.totalPages === 0 ? '0' : data.page}/{data.totalPages} · {data.total} hội viên</span>
          <button type="button" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}><Icon name="next" label="Trang sau" /></button>
        </div>
      </div>
    </>}
    </section>
  </section>;
}
