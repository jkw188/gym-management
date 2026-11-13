// Tầng giao diện – trang (US-13 bước 2): /services – Guest/Member xem gói GYM/PT đang bán, lọc loại/giá, tìm kiếm, xem chi tiết.
// Chỉ xem: không có nút mua/thanh toán, không gửi request ghi nào; đăng ký làm tại quầy (US-13-F04, TC10).
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { formatVnd } from '../plans/plans.api';
import { servicesApi, type PublicPlan, type PublicPlanPage } from './services.api';

const errorText = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

// Ô giá chỉ giữ chữ số, để luôn gửi chuỗi số nguyên VND (EN-02).
const digitsOnly = (text: string) => text.replace(/\D/g, '');

// US-13-F05: gói PT hiện số buổi; gói GYM có quota 0 thì KHÔNG hiện "0 buổi tập".
const sessionsText = (plan: PublicPlan) => (plan.kind === 'PT' ? `${plan.sessionsQuota} buổi tập` : '');

export function ServicesPage() {
  // Giá trị đang gõ trong các ô lọc.
  const [kind, setKind] = useState('');
  const [searchText, setSearchText] = useState('');
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  // Giá trị đã "chốt" sau 300ms ngừng gõ – chỉ các giá trị này mới được gửi lên server.
  const [q, setQ] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [page, setPage] = useState(1);
  // Tăng số này để tải lại danh sách với đúng bộ lọc hiện tại (nút "Thử lại", detail 404).
  const [reloadCount, setReloadCount] = useState(0);

  const [data, setData] = useState<PublicPlanPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<PublicPlan | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  // Số lượt mở chi tiết: tăng mỗi lần mở/đóng/đổi bộ lọc để bỏ kết quả chi tiết về muộn.
  const detailRound = useRef(0);
  // Nút "Xem chi tiết" của từng gói, để trả focus về đúng nút khi đóng chi tiết (US-13-TC12).
  const detailButtons = useRef(new Map<string, HTMLButtonElement>());
  const detailHeading = useRef<HTMLHeadingElement>(null);

  // US-13-TC12: debounce 300ms – gõ nhanh "Gym" chỉ gửi một request q=Gym.
  useEffect(() => {
    const timer = setTimeout(() => {
      const nextQ = searchText.trim();
      // Không có gì thay đổi (ví dụ chỉ thêm khoảng trắng) thì không gửi request thừa.
      if (nextQ === q && minText === minPrice && maxText === maxPrice) return;
      startNewFilter();
      setQ(nextQ);
      setMinPrice(minText);
      setMaxPrice(maxText);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchText, minText, maxText, q, minPrice, maxPrice]);

  // Tải danh sách mỗi khi bộ lọc đã chốt, trang đổi hoặc bấm tải lại.
  useEffect(() => {
    // US-13-TC12: ignore = true khi bộ lọc đã đổi tiếp, để response cũ về muộn không ghi đè kết quả mới.
    let ignore = false;
    setLoading(true);
    setListError('');
    // US-13-TC11: đang tải hoặc lỗi thì không hiện danh sách cũ như thể vẫn đúng.
    setData(null);
    servicesApi.list({ kind, q, minPrice, maxPrice, page })
      .then(result => { if (!ignore) setData(result); })
      .catch(error => { if (!ignore) setListError(errorText(error, 'Không tải được danh mục dịch vụ.')); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [kind, q, minPrice, maxPrice, page, reloadCount]);

  // Mở chi tiết thì đưa focus vào tiêu đề vùng chi tiết (US-13-TC12).
  useEffect(() => {
    if (selected) detailHeading.current?.focus();
  }, [selected]);

  // US-13-TC07: đổi bộ lọc thì về trang 1, đóng chi tiết và xóa thông báo cũ.
  function startNewFilter() {
    detailRound.current += 1;
    setPage(1);
    setSelected(null);
    setNotice('');
  }

  function changeKind(value: string) {
    startNewFilter();
    setKind(value);
  }

  function changePage(nextPage: number) {
    detailRound.current += 1;
    setSelected(null);
    setPage(nextPage);
  }

  // US-13-TC09: "Xem chi tiết" luôn hỏi lại server, không dùng bản trong danh sách hay bản đã xem trước.
  async function openDetail(id: string) {
    detailRound.current += 1;
    const round = detailRound.current;
    setNotice('');
    setShowGuide(false);
    // Không giữ chi tiết gói cũ trong lúc chờ gói mới.
    setSelected(null);
    try {
      const plan = await servicesApi.detail(id);
      if (round !== detailRound.current) return;
      setSelected(plan);
    } catch (error) {
      if (round !== detailRound.current) return;
      // US-13-TC09: gói vừa ngừng bán → báo, đóng chi tiết và tải lại danh mục.
      if (error instanceof ApiError && error.code === 'PLAN_NOT_FOUND') {
        setNotice('Dịch vụ này không còn khả dụng. Danh mục đã được tải lại.');
        setReloadCount(count => count + 1);
      } else {
        setNotice(errorText(error, 'Không tải được chi tiết dịch vụ.'));
      }
    }
  }

  // US-13-TC12: đóng chi tiết thì focus về nút "Xem chi tiết" của gói vừa xem.
  function closeDetail() {
    const planId = selected?.id;
    detailRound.current += 1;
    setSelected(null);
    if (planId) detailButtons.current.get(planId)?.focus();
  }

  return <section className="auth-card classes-page">
    <h1>Gói dịch vụ</h1>
    <p>Giá và quyền lợi hiện tại của các gói GYM/PT. Trang này chỉ để xem, chưa giữ giá hay giữ chỗ.</p>

    {/* Bộ lọc: loại áp dụng ngay; tìm kiếm và giá chờ 300ms sau khi ngừng gõ. */}
    <div className="toolbar">
      <label>Loại gói
        <select value={kind} onChange={event => changeKind(event.target.value)}>
          <option value="">Tất cả</option>
          <option value="GYM">Gym</option>
          <option value="PT">PT</option>
        </select>
      </label>
      <label>Giá từ (VND)
        <input inputMode="numeric" maxLength={12} value={minText} onChange={event => setMinText(digitsOnly(event.target.value))} />
      </label>
      <label>Giá đến (VND)
        <input inputMode="numeric" maxLength={12} value={maxText} onChange={event => setMaxText(digitsOnly(event.target.value))} />
      </label>
      <label>Tìm dịch vụ
        <input type="search" maxLength={120} value={searchText} onChange={event => setSearchText(event.target.value)} />
      </label>
    </div>

    {notice && <p className="form-error" role="alert">{notice}</p>}

    {loading && <p>Đang tải danh mục...</p>}

    {/* US-13-TC11: lỗi DB/mạng có nút thử lại, giữ nguyên bộ lọc; không hiện danh mục rỗng hay giá 0. */}
    {listError && <div className="form-error" role="alert"><p>{listError}</p>
      <button type="button" onClick={() => setReloadCount(count => count + 1)}><Icon name="retry" label="Thử lại" /></button></div>}

    {/* US-13-TC07: không có kết quả. */}
    {data && data.items.length === 0 && <p>Không tìm thấy dịch vụ phù hợp</p>}

    {/* US-13-TC07: giữ đúng thứ tự server trả (name rồi _id). US-13-TC08: dữ liệu hiển thị bằng {} nên luôn là chữ. */}
    {data && data.items.length > 0 && <ul aria-label="Danh sách dịch vụ" className="class-list">
      {data.items.map(plan => <li key={plan.id} className="shift-item">
        <strong>{plan.name}</strong>
        <span>{formatVnd(plan.price)}</span>
        <span>{plan.durationDays} ngày</span>
        {plan.kind === 'PT' && <span>{sessionsText(plan)}</span>}
        <div className="shift-item-actions">
          <button type="button" className="secondary" onClick={() => openDetail(plan.id)}
            ref={node => { if (node) detailButtons.current.set(plan.id, node); else detailButtons.current.delete(plan.id); }}>
            Xem chi tiết
          </button>
        </div>
      </li>)}
    </ul>}

    {data && data.totalPages > 1 && <div className="user-actions">
      {data.page > 1 && <button type="button" className="secondary" onClick={() => changePage(page - 1)}><Icon name="prev" label="Trang trước" /></button>}
      <span>Trang {data.page}/{data.totalPages}</span>
      {data.page < data.totalPages && <button type="button" className="secondary" onClick={() => changePage(page + 1)}><Icon name="next" label="Trang sau" /></button>}
    </div>}

    {selected && <section aria-label="Chi tiết dịch vụ" className="auth-card">
      <h3 ref={detailHeading} tabIndex={-1}>{selected.name}</h3>
      <dl className="class-detail">
        <dt>Mã gói</dt><dd>{selected.code}</dd>
        <dt>Giá</dt><dd>{formatVnd(selected.price)}</dd>
        <dt>Thời hạn</dt><dd>{selected.durationDays} ngày</dd>
        {selected.kind === 'PT' && <><dt>Số buổi</dt><dd>{sessionsText(selected)}</dd></>}
        {/* US-13-TC08: quyền lợi hiện dạng chữ, không chèn HTML. */}
        <dt>Quyền lợi</dt><dd className="plan-benefits">{selected.benefits}</dd>
      </dl>
      {/* US-13-TC10: chỉ hướng dẫn, không gọi API bán hàng/thanh toán. */}
      {showGuide && <p>Vui lòng đến quầy lễ tân để nhân viên tư vấn và đăng ký gói tại quầy. Giá sẽ được kiểm tra lại khi đăng ký.</p>}
      <div className="user-actions">
        <button type="button" onClick={() => setShowGuide(true)}>Hướng dẫn đăng ký</button>
        <button type="button" className="secondary" onClick={closeDetail}>Quay lại danh mục</button>
      </div>
    </section>}
  </section>;
}
