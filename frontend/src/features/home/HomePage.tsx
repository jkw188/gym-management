// Tầng giao diện – trang: trang chủ cho Guest (chưa đăng nhập) theo bản thiết kế HomeUI.
// Chỉ đọc dữ liệu công khai (gói tập, sản phẩm) qua API có sẵn; không có luật nghiệp vụ, lỗi tải thì ẩn phần đó.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { servicesApi, type PublicPlan } from '../services/services.api';
import { shopApi, type PublicProduct } from '../shop/shop.api';
import { ShopImage } from '../shop/ShopParts';
import { formatVnd } from '../../utils/money';
import { useAuth } from '../auth/AuthProvider';

// Số gói và sản phẩm hiện ở trang chủ; muốn xem hết thì bấm "Xem tất cả".
const PLAN_COUNT = 3;
const PRODUCT_COUNT = 4;

export function HomePage() {
  const { user } = useAuth();
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [products, setProducts] = useState<PublicProduct[]>([]);

  useEffect(() => {
    // ignore = true khi rời trang trước lúc API trả về, để không cập nhật state của trang đã đóng.
    let ignore = false;
    servicesApi.list({ kind: '', q: '', minPrice: '', maxPrice: '', page: 1 })
      .then(page => { if (!ignore) setPlans(page.items.slice(0, PLAN_COUNT)); })
      .catch(() => undefined);
    shopApi.listProducts({ q: '', categoryId: '', availability: '' })
      .then(page => { if (!ignore) setProducts(page.items.slice(0, PRODUCT_COUNT)); })
      .catch(() => undefined);
    return () => { ignore = true; };
  }, []);

  return <div className="home-page">
    {/* Khối mở đầu: giới thiệu bên trái, ảnh phòng tập bên phải (ảnh lấy từ bản thiết kế Stitch, lưu ở public/images). */}
    <section className="home-hero">
      <div className="home-hero-text">
        <p className="eyebrow">Câu lạc bộ thể hình</p>
        <h1>Rèn luyện thể lực và sự tập trung</h1>
        <p>Không gian tập luyện hiện đại, huấn luyện viên 1 kèm 1 và lớp nhóm miễn phí mỗi tuần.</p>
        <div className="home-actions">
          <Link to="/services" className="button-link">Xem gói tập</Link>
          <Link to="/classes" className="button-link secondary-link">Xem lịch lớp</Link>
        </div>
        <dl className="home-stats">
          <div><dt>Mở cửa</dt><dd>5:30 – 22:00</dd></div>
          <div><dt>Huấn luyện</dt><dd>1 kèm 1</dd></div>
          <div><dt>Lớp nhóm</dt><dd>Miễn phí</dd></div>
        </dl>
      </div>
      <figure className="home-hero-media">
        <img src="/images/gym-hero.jpg" alt="Giá tạ đơn trong khu tập tự do của phòng gym" width="1408" height="768" />
        <figcaption>Khu tạ tự do</figcaption>
      </figure>
    </section>

    {plans.length > 0 && <section className="home-section" aria-labelledby="home-plans-title">
      <div className="home-section-head">
        <div><p className="eyebrow">Chọn lộ trình</p><h2 id="home-plans-title">Gói tập và dịch vụ PT</h2></div>
        <Link to="/services">Xem tất cả gói</Link>
      </div>
      <ul className="home-grid home-grid-3">
        {plans.map(plan => <li key={plan.id} className="home-card">
          <span className="tag">{plan.kind === 'PT' ? 'Gói PT' : 'Gói Gym'}</span>
          <h3>{plan.name}</h3>
          <p className="home-price">{formatVnd(plan.price)}</p>
          <p className="hint">{plan.durationDays} ngày{plan.kind === 'PT' ? ` · ${plan.sessionsQuota} buổi PT` : ''}</p>
          <p className="plan-benefits">{plan.benefits}</p>
        </li>)}
      </ul>
    </section>}

    {products.length > 0 && <section className="home-section" aria-labelledby="home-products-title">
      <div className="home-section-head">
        <div><p className="eyebrow">Phụ kiện và dinh dưỡng</p><h2 id="home-products-title">Sản phẩm</h2></div>
        <Link to="/shop">Xem cửa hàng</Link>
      </div>
      <ul className="home-grid home-grid-4">
        {products.map(product => <li key={product.id} className="home-card">
          <ShopImage url={product.imageUrl} name={product.name} size={240} />
          <span className="eyebrow">{product.category.name}</span>
          <h3><Link to={`/shop/${product.id}`}>{product.name}</Link></h3>
          <p className="home-price">{formatVnd(product.price)}</p>
        </li>)}
      </ul>
    </section>}

    {/* Đã đăng nhập thì không mời tạo tài khoản nữa. */}
    {!user && <section className="home-cta">
      <div><p className="eyebrow">Trở thành hội viên</p><h2>Tạo tài khoản để đặt lịch PT và mua hàng</h2></div>
      <Link to="/register" className="button-link">Tạo tài khoản hội viên</Link>
    </section>}
  </div>;
}
