import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, apiClient } from '../../api/client';
import { useAuth } from '../auth/AuthProvider';
import { roleNames } from '../auth/auth.routes';
import type { RoleCode } from '../auth/auth.types';
import { UserForm } from './UserForm';
import { AccountStatusDialog } from './AccountStatusDialog';
import { AccountRoleDialog } from './AccountRoleDialog';
import { usersApi, type UserAccount, type UserRole, type UsersPage as PageData, type UsersQuery } from './users.api';
import { Icon } from '../../components/Icon';

type Editor = { mode: 'create' } | { mode: 'edit'; id: string; account?: UserAccount; error?: string };

export function UsersPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState<UsersQuery>({ page: 1, limit: 20 });
  const [q, setQ] = useState('');
  const [roleCode, setRoleCode] = useState('');
  const [status, setStatus] = useState('');
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [rolesRevision, setRolesRevision] = useState(0);
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [rolesError, setRolesError] = useState<string>();
  const [rolesLoading, setRolesLoading] = useState(true);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [statusTarget, setStatusTarget] = useState<string>();
  const [roleTarget, setRoleTarget] = useState<string>();
  const [notice, setNotice] = useState('');
  const detailRequest = useRef<AbortController | null>(null);

  const message = (failure: unknown) => {
    const text = failure instanceof Error ? failure.message : 'Không thể tải dữ liệu.';
    return failure instanceof ApiError && failure.requestId ? `${text} Mã tra cứu: ${failure.requestId}` : text;
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(undefined); setData(null);
    void usersApi.list(query, controller.signal).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(message(failure));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, revision]);

  useEffect(() => {
    const controller = new AbortController();
    setRolesLoading(true); setRolesError(undefined);
    void usersApi.roles(controller.signal).then(result => {
      if (!controller.signal.aborted) setRoles(result.items);
    }).catch(failure => {
      if (!controller.signal.aborted) setRolesError(message(failure));
    }).finally(() => { if (!controller.signal.aborted) setRolesLoading(false); });
    return () => controller.abort();
  }, [rolesRevision]);

  useEffect(() => () => detailRequest.current?.abort(), []);

  async function edit(id: string) {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setEditor({ mode: 'edit', id });
    try {
      const account = await usersApi.detail(id, controller.signal);
      if (!controller.signal.aborted) setEditor({ mode: 'edit', id, account });
    } catch (failure) {
      if (!controller.signal.aborted) setEditor({ mode: 'edit', id, error: message(failure) });
    }
  }

  function saved(account: UserAccount, created: boolean, identityChanged: boolean) {
    if (!created && account.id === user?.id) {
      if (identityChanged) {
        apiClient.requireLogin();
        navigate('/login?reason=identity-changed', { replace: true });
        return;
      }
      apiClient.updateCurrentUser({ id: account.id, fullName: account.fullName, phone: account.phone,
        ...(account.email ? { email: account.email } : {}), roleCode: account.roleCode });
    }
    setEditor(null);
    setNotice(`${created ? 'Đã tạo' : 'Đã lưu'} tài khoản ${account.id}.`);
    setRevision(value => value + 1);
  }

  function filter(event: FormEvent) {
    event.preventDefault();
    setQuery(current => ({ ...current, page: 1, q: q.trim(), roleCode, status }));
  }

  return <section aria-labelledby="users-title">
    <Link to="/admin">Về trang quản trị</Link><h2 id="users-title">Quản lý tài khoản</h2>
    <p>Tạo, sửa thông tin, phân quyền và khóa/mở khóa tài khoản. Hội viên mới cần hồ sơ và gói tập riêng để sử dụng dịch vụ.</p>
    {roleTarget && <AccountRoleDialog key={roleTarget} id={roleTarget} ownAccount={roleTarget === user?.id}
      onClose={() => setRoleTarget(undefined)}
      onUnauthenticated={() => { apiClient.requireLogin(); navigate('/login', { replace: true }); }}
      onSaved={result => {
        if (result.reauthenticationRequired) { apiClient.requireLogin(); navigate('/login', { replace: true }); return; }
        setRoleTarget(undefined);
        setNotice(result.changed ? `Đã phân quyền ${result.user.roleName} cho tài khoản ${result.user.id}. Các phiên cũ đã mất hiệu lực.` : 'Vai trò đã đúng, không có thay đổi.');
        setData(current => current ? { ...current, items: current.items.map(item => item.id === result.user.id ? result.user : item) } : null);
        setRevision(value => value + 1);
      }} />}
    {statusTarget && <AccountStatusDialog key={statusTarget} id={statusTarget} ownAccount={statusTarget === user?.id}
      onClose={() => setStatusTarget(undefined)}
      onUnauthenticated={() => { apiClient.requireLogin(); navigate('/login', { replace: true }); }}
      onSaved={result => {
        if (result.reauthenticationRequired) { apiClient.requireLogin(); navigate('/login', { replace: true }); return; }
        setStatusTarget(undefined);
        setNotice(result.changed ? `Đã ${result.user.status === 'LOCKED' ? 'khóa' : 'mở khóa'} tài khoản ${result.user.id}.` : 'Trạng thái tài khoản đã đúng, không có thay đổi.');
        setData(current => current ? { ...current, items: current.items.map(item => item.id === result.user.id ? result.user : item) } : null);
        setRevision(value => value + 1);
      }} />}
    {notice && <p role="status" className="user-notice">{notice}</p>}
    <div className="user-actions"><button type="button" disabled={!!editor || !!statusTarget || !!roleTarget || rolesLoading || !!rolesError || !roles.length} onClick={() => setEditor({ mode: 'create' })}>Tạo tài khoản mới</button>
      <button type="button" className="secondary" disabled={loading} onClick={() => setRevision(value => value + 1)}><Icon name="retry" label="Tải lại danh sách" showLabel /></button></div>
    {rolesLoading && <p role="status">Đang tải vai trò…</p>}
    {rolesError && <div role="alert" className="form-error">{rolesError} <button type="button" onClick={() => setRolesRevision(value => value + 1)}><Icon name="retry" label="Tải lại vai trò" showLabel /></button></div>}
    {!rolesLoading && !rolesError && !roles.length && <p role="alert">Chưa có vai trò. Cần chạy seed trước khi tạo tài khoản.</p>}
    {editor?.mode === 'create' && <UserForm roles={roles} onClose={() => setEditor(null)} onSaved={saved} onReload={() => {}} />}
    {editor?.mode === 'edit' && (editor.account ? <UserForm key={`${editor.id}-${editor.account.version}`} account={editor.account} roles={roles}
      onClose={() => setEditor(null)} onSaved={saved} onReload={() => void edit(editor.id)} /> : <section className="status-card">
      {editor.error ? <><p role="alert">{editor.error}</p><button type="button" onClick={() => void edit(editor.id)}><Icon name="retry" label="Tải lại chi tiết" showLabel /></button></> : <p role="status">Đang tải thông tin tài khoản…</p>}
      <button type="button" className="secondary" onClick={() => { detailRequest.current?.abort(); setEditor(null); }}><Icon name="close" label="Đóng" /></button></section>)}
    <form className="users-filter" onSubmit={filter}>
      <label htmlFor="users-search">Tìm tên, email hoặc số điện thoại</label><input id="users-search" value={q} maxLength={120} onChange={event => setQ(event.target.value)} />
      <div className="users-filter-row"><div><label htmlFor="users-role">Lọc vai trò</label><select id="users-role" value={roleCode} onChange={event => setRoleCode(event.target.value)}>
        <option value="">Tất cả vai trò</option>{(Object.keys(roleNames) as RoleCode[]).map(code => <option key={code} value={code}>{roleNames[code]}</option>)}
      </select></div><div><label htmlFor="users-status">Lọc trạng thái</label><select id="users-status" value={status} onChange={event => setStatus(event.target.value)}>
        <option value="">Tất cả trạng thái</option><option value="ACTIVE">Hoạt động</option><option value="LOCKED">Đã khóa</option>
      </select></div></div><button type="submit"><Icon name="filter" label="Áp dụng bộ lọc" showLabel /></button>
    </form>
    {loading && <p role="status">Đang tải danh sách…</p>}
    {error && <p className="form-error" role="alert">{error} Hãy dùng nút tải lại danh sách.</p>}
    {data && <>
      <p>{data.total} tài khoản</p>
      {data.items.length ? <div className="users-table-wrap"><table className="users-table"><caption>Danh sách tài khoản</caption>
        <thead><tr><th scope="col">Họ tên</th><th scope="col">Liên hệ</th><th scope="col">Vai trò</th><th scope="col">Trạng thái</th><th scope="col">Thao tác</th></tr></thead>
        <tbody>{data.items.map(account => <tr key={account.id}><td>{account.fullName}</td><td>{account.phone}{account.email && <><br />{account.email}</>}</td>
          <td>{account.roleName}</td><td>{account.status === 'ACTIVE' ? 'Hoạt động' : 'Đã khóa'}</td>
          <td><button type="button" className="secondary" disabled={!!editor || !!statusTarget || !!roleTarget} aria-label={`Xem và sửa ${account.fullName}`} onClick={() => void edit(account.id)}>Xem / Sửa</button>
            <button type="button" className="secondary" disabled={!!editor || !!statusTarget || !!roleTarget} aria-label={`Khóa / Mở khóa ${account.fullName}`} onClick={() => setStatusTarget(account.id)}>Khóa / Mở khóa</button>
            <button type="button" className="secondary" disabled={!!editor || !!statusTarget || !!roleTarget} aria-label={`Phân quyền ${account.fullName}`} onClick={() => setRoleTarget(account.id)}>Phân quyền</button></td></tr>)}</tbody>
      </table></div> : <p>Không có tài khoản phù hợp.</p>}
      <div className="user-actions" aria-label="Phân trang">
        <button type="button" disabled={loading || query.page <= 1} onClick={() => setQuery(current => ({ ...current, page: current.page - 1 }))}><Icon name="prev" label="Trang trước" /></button>
        <span>Trang {data.page} / {data.totalPages}</span>
        <button type="button" disabled={loading || query.page >= data.totalPages} onClick={() => setQuery(current => ({ ...current, page: current.page + 1 }))}><Icon name="next" label="Trang sau" /></button>
        <label htmlFor="users-limit">Mỗi trang</label><select id="users-limit" value={query.limit} onChange={event => setQuery(current => ({ ...current, page: 1, limit: Number(event.target.value) }))}>
          {[20, 50, 100].map(limit => <option key={limit} value={limit}>{limit}</option>)}</select>
      </div>
    </>}
  </section>;
}
