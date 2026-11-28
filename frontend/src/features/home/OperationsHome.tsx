import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon, type IconName } from '../../components/Icon';
import { formatVnd } from '../../utils/money';
import { rolePaths } from '../auth/auth.routes';
import { servicesApi, type PublicPlan } from '../services/services.api';
import { shopApi, type PublicProduct } from '../shop/shop.api';
import { canRetry } from '../shop/ShopParts';

const loadPlans = async () => (await servicesApi.list({ kind: '', q: '', minPrice: '', maxPrice: '', page: 1 })).items.slice(0, 3);
const loadProducts = async () => (await shopApi.listProducts({ q: '', categoryId: '', availability: '' })).items.slice(0, 4);
const planPeriod = (plan: PublicPlan) => `${plan.kind === 'PT' ? `${plan.sessionsQuota} buổi · ` : ''}${plan.durationDays} ngày`;
const greetingDate = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Ho_Chi_Minh' });

function FeaturedSection<T>({ id, title, subtitle, to, linkLabel, empty, load, children }: {
  id: string; title: string; subtitle: string; to: string; linkLabel: string; empty: string;
  load: () => Promise<T[]>; children: (items: T[]) => ReactNode;
}) {
  const [result, setResult] = useState<{ items: T[] } | { error: unknown } | null>(null);
  const [revision, setRevision] = useState(0);
  const loading = result === null;
  useEffect(() => {
    let active = true;
    load().then(items => { if (active) setResult({ items }); }, error => { if (active) setResult({ error }); });
    return () => { active = false; };
  }, [load, revision]);
  return <section className="gm-panel gm-featured" aria-labelledby={id} aria-busy={loading}>
    <div className="gm-section-head"><div><h2 id={id}>{title}</h2><p>{subtitle}</p></div>
      <Link to={to}>{linkLabel} <Icon name="arrow" /></Link></div>
    {loading && <p className="gm-featured-message">Đang tải…</p>}
    {result && 'error' in result && <div className="gm-featured-message" role="alert">
      <div>Không tải được dữ liệu.
        {result.error instanceof ApiError && <><p>{result.error.message}</p>
          {result.error.requestId && <small>Mã tra cứu {result.error.requestId}</small>}</>}
      </div>
      {canRetry(result.error) && <button type="button" className="secondary" onClick={() => {
        setResult(null);
        setRevision(value => value + 1);
      }}>Thử lại</button>}
    </div>}
    {result && 'items' in result && (result.items.length ? children(result.items) : <p className="gm-featured-message">{empty}</p>)}
  </section>;
}

export function OperationsHome({ role, name }: { role: 'ADMIN' | 'STAFF'; name: string }) {
  const [selected, setSelected] = useState<PublicPlan | null>(null);
  const planDialog = useRef<HTMLDialogElement>(null);
  const home = rolePaths[role];
  const shortcuts: { to: string; title: string; text: string; icon: IconName }[] = [
    { to: `${home}/members`, title: 'Tra cứu hội viên', text: 'Tìm hồ sơ và quyền lợi', icon: 'users' },
    { to: `${home}/pos`, title: 'Bán tại quầy', text: 'Lập đơn và bàn giao hàng', icon: 'cart' },
  ];
  if (role === 'ADMIN') shortcuts.push({ to: '/admin/reports/cash-flow', title: 'Báo cáo thu & hoàn', text: 'Đối chiếu dòng tiền', icon: 'chart' });

  return <div className="gm-dashboard">
    <div className="gm-dashboard-top">
      <section className="gm-hero" aria-labelledby="gm-home-title">
        <div className="gm-hero-photo" aria-hidden="true" />
        <div className="gm-hero-content">
          <p className="gm-hero-date"><Icon name="calendar" />{greetingDate.format(new Date())}</p>
          <h1 id="gm-home-title">Xin chào, <span>{name}!</span></h1>
          <p className="gm-hero-description">Tra cứu hội viên, xử lý giao dịch và theo dõi hoạt động phòng tập.</p>
          <div className="gm-hero-actions">
            <Link to="/services"><Icon name="weights" />Xem gói tập</Link>
            <Link to="/classes"><Icon name="calendar" />Xem lịch lớp</Link>
          </div>
        </div>
      </section>
      <section className="gm-panel gm-quick" aria-labelledby="gm-quick-title">
        <h2 id="gm-quick-title">Truy cập nhanh</h2>
        <div className="gm-quick-links">{shortcuts.map(item => <Link key={item.to} to={item.to}>
          <span className="gm-icon-tile"><Icon name={item.icon} /></span>
          <span><strong>{item.title}</strong><small>{item.text}</small></span><Icon name="next" />
        </Link>)}</div>
      </section>
    </div>
    <div className="gm-dashboard-featured">
      <FeaturedSection id="gm-plans-title" title="Gói tập nổi bật" subtitle="Gói Gym và huấn luyện cá nhân"
        to="/services" linkLabel="Xem tất cả" empty="Chưa có gói đang bán." load={loadPlans}>
        {plans => <ul className="gm-plan-cards">{plans.map(plan => <li key={plan.id}>
          <button type="button" className="secondary" onClick={() => { setSelected(plan); planDialog.current?.showModal(); }} aria-haspopup="dialog">
            <span className="gm-icon-tile" data-kind={plan.kind}><Icon name={plan.kind === 'PT' ? 'bolt' : 'weights'} /></span>
            <strong>{plan.name}</strong><small>{planPeriod(plan)}</small><b>{formatVnd(plan.price)}</b>
          </button>
        </li>)}</ul>}
      </FeaturedSection>
      <FeaturedSection<PublicProduct> id="gm-products-title" title="Sản phẩm nổi bật" subtitle="Phụ kiện và dụng cụ tập luyện"
        to="/shop" linkLabel="Xem cửa hàng" empty="Chưa có sản phẩm đang bán." load={loadProducts}>
        {products => <ul className="gm-product-cards">{products.map(product => <li key={product.id}>
          <Link to={`/shop/${product.id}`}>
            <span className="gm-icon-tile"><Icon name="bag" /></span>
            <span><strong>{product.name}</strong><small>{product.category.name}</small><b>{formatVnd(product.price)}</b></span>
          </Link>
        </li>)}</ul>}
      </FeaturedSection>
    </div>
    <dialog className="gm-dialog" ref={planDialog} aria-labelledby="gm-plan-details"
      onClick={event => { if (event.target === event.currentTarget) planDialog.current?.close(); }}>
      <div className="gm-dialog-body">
        <div className="gm-dialog-head"><h2 id="gm-plan-details">{selected?.name ?? 'Thông tin gói tập'}</h2>
          <button type="button" className="secondary" onClick={() => planDialog.current?.close()}><Icon name="close" label="Đóng thông tin gói" /></button></div>
        {selected && <><p>{selected.kind} · {planPeriod(selected)} · {formatVnd(selected.price)}</p><p>{selected.benefits}</p></>}
        <Link to="/services">Xem danh mục gói tập</Link>
      </div>
    </dialog>
  </div>;
}
