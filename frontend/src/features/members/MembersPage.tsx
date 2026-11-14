import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { membersApi, type MemberListItem, type MemberPage, type MembershipState, type ServiceKind } from './members.api';
import { MemberEntitlements, MemberReadTime, membershipStateNames } from './MemberEntitlements';
import { Icon } from '../../components/Icon';

export function MembersPage() {
  const { pathname } = useLocation();
  const base = pathname.startsWith('/admin') ? '/admin/members' : '/staff/members';
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<ServiceKind | ''>('');
  const [membershipState, setMembershipState] = useState<MembershipState | ''>('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<MemberPage<MemberListItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const round = useRef(0);

  // Invalidate ngay khi nhập, kể cả trong khoảng debounce, không chờ request mới được gửi.
  function change(update: () => void) {
    round.current += 1; setData(null); setError(''); setLoading(true); update();
  }
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
  }, [q, kind, membershipState, page, reload]);

  return <section className="auth-card">
    {/* Tiêu đề bên trái, link tạo hồ sơ dạng nút bên phải. */}
    <div className="page-head"><h2>Tra cứu hội viên</h2><Link className="button-link" to={`${base}/new`}>Tạo hồ sơ hội viên</Link></div>
    {/* Ô tìm và hai ô lọc trên một hàng. */}
    <div className="toolbar">
    <div className="toolbar-search"><label htmlFor="member-search">Mã, tên hoặc số điện thoại</label>
    <input id="member-search" value={q} maxLength={120} onChange={event => change(() => { setQ(event.target.value); setPage(1); })} /></div>
    <div><label htmlFor="member-kind">Loại dịch vụ</label>
    <select id="member-kind" value={kind} onChange={event => change(() => { setKind(event.target.value as ServiceKind | ''); setPage(1); })}>
      <option value="">Tất cả loại</option><option value="GYM">GYM</option><option value="PT">PT</option>
    </select></div>
    <div><label htmlFor="member-state">Trạng thái gói</label>
    <select id="member-state" value={membershipState} onChange={event => change(() => { setMembershipState(event.target.value as MembershipState | ''); setPage(1); })}>
      <option value="">Tất cả trạng thái</option>
      {Object.entries(membershipStateNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></div>
    </div>
    {loading && <p role="status">Đang tải hội viên…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => change(() => setReload(value => value + 1))}><Icon name="retry" label="Thử lại" /></button></div>}
    {data && <><MemberReadTime time={data} />
      {data.items.length === 0 ? <p>Không tìm thấy hội viên phù hợp.</p> : <ul aria-label="Danh sách hội viên">
        {data.items.map(member => <li key={member.id}>
          <Link to={`${base}/${member.id}`}>{member.memberCode} — {member.fullName}</Link>
          <p>{member.phone} · {member.accountLinked ? 'Đã liên kết tài khoản' : 'Chưa liên kết tài khoản'}</p>
          <MemberEntitlements summary={member.entitlementSummary} />
        </li>)}
      </ul>}
      <div className="user-actions">
        <button type="button" disabled={page <= 1} onClick={() => change(() => setPage(value => value - 1))}><Icon name="prev" label="Trang trước" /></button>
        <span>Trang {data.page}/{data.totalPages} · {data.total} hội viên</span>
        <button type="button" disabled={page >= data.totalPages} onClick={() => change(() => setPage(value => value + 1))}><Icon name="next" label="Trang sau" /></button>
      </div>
    </>}
  </section>;
}
