// Tầng giao diện – trang (US-17 bước 3, US-19 bước 3): trang /member/memberships – gói hiện hành, chờ hiệu lực, lịch sử,
// giao dịch chờ xác nhận, lịch sử mua và chứng từ của chính Member. timeState và số buổi lấy từ server, React không tự tính.
// US-19: nút "Gia hạn" mở RenewalPanel; kỳ nào có nút do server quyết định qua field renewal.
// US-20: gói đang hiệu lực có link "Nâng cấp" sang trang MembershipUpgradePage.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useAccountId } from '../notifications/inbox-signals';
import {
  membershipsApi, type MyInvoice, type MyMembership, type MyServiceSale, type MyTransaction, type SaleOperation,
  type TransactionStatus,
} from './memberships.api';
import { Icon } from '../../components/Icon';
import { RenewalPanel, type RenewalTarget } from './RenewalPanel';
import { buyerLabel } from '../payments/payments-format';

// membershipsTotal/salesTotal là total server trả về, để biết còn bản ghi chưa tải (US-17-TC10).
interface PageData {
  memberLinked: boolean; memberships: MyMembership[]; sales: MyServiceSale[]; membershipsTotal: number; salesTotal: number;
}

const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

// "2026-12-01" → "01/12/2026". Tách chuỗi, không qua Date, nên không bị lệch ngày do múi giờ (US-17-TC12).
function formatDate(value: string): string {
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

// Thời điểm (ISO) hiển thị theo giờ Việt Nam.
const formatDateTime = (value: string) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

// "1500000" → "1.500.000 đ". Xử lý trên chuỗi, không đổi sang Number nên không mất chính xác (EN02-D02).
function formatVnd(value: string): string {
  return `${value.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} đ`;
}

const OPERATION_LABELS: Record<SaleOperation, string> = { REGISTER: 'Đăng ký mới', RENEW: 'Gia hạn', UPGRADE: 'Nâng cấp' };
const SALE_STATUS_LABELS: Record<TransactionStatus, string> = {
  PENDING: 'Chờ xác nhận thu', SETTLED: 'Đã thu tiền', CANCELLED: 'Đã hủy',
};

// US-17-F02: chỉ ACTIVE + CURRENT là gói đang cấp quyền; ACTIVE + SCHEDULED là chờ hiệu lực; còn lại vào lịch sử.
const isCurrent = (item: MyMembership) => item.storedStatus === 'ACTIVE' && item.timeState === 'CURRENT';
const isScheduled = (item: MyMembership) => item.storedStatus === 'ACTIVE' && item.timeState === 'SCHEDULED';

// US-17-TC12: nhãn cho gói trong lịch sử.
function historyLabel(item: MyMembership): string {
  if (item.storedStatus === 'SUPERSEDED') return 'Đã được thay thế';
  if (item.storedStatus === 'CANCELLED') return 'Đã hủy';
  return 'Đã hết hạn';
}

function MembershipCard({ item, inHistory, onRenew }: { item: MyMembership; inHistory: boolean; onRenew: (item: MyMembership) => void }) {
  return <article aria-label={item.planName} className="membership-card">
    <h4>{item.planName}</h4>
    {inHistory && <p><strong>{historyLabel(item)}</strong></p>}
    {/* US-17-TC12: ngày cuối vẫn được dùng nên ghi "đến hết ngày". */}
    <p>Từ {formatDate(item.startDate)} đến hết ngày {formatDate(item.endDate)}</p>
    <p>Nguồn: {OPERATION_LABELS[item.operation]}</p>
    <p>{item.benefits}</p>
    {item.kind === 'PT'
      ? <ul>
        <li>Đã dùng: {item.sessionsUsed}/{item.sessionsQuota} buổi</li>
        <li>Đang giữ chỗ: {item.sessionsReserved} buổi</li>
        {/* Gói trong lịch sử không còn đặt buổi được nên không hiện số còn lại. */}
        {!inHistory && <li>Còn đặt được: {item.sessionsAvailable} buổi</li>}
      </ul>
      // US-17-TC12: gói GYM có quota 0 nhưng vẫn tập được, không ghi "hết buổi".
      : <p>Không áp dụng số buổi PT</p>}
    {/* US-19-TC12: chỉ kỳ đuôi còn gia hạn được (server trả renewal) mới có nút. */}
    {item.renewal && <button type="button" onClick={() => onRenew(item)}>Gia hạn</button>}
    {/* US-20-TC01: chỉ gói đang hiệu lực có link "Nâng cấp"; gói đích được phép vẫn do server quyết định. */}
    {isCurrent(item) && <Link to={`/member/memberships/${item.id}/upgrade`}>Nâng cấp</Link>}
  </article>;
}

function MembershipGroup({ title, id, items, inHistory, emptyText, onRenew }: {
  title: string; id: string; items: MyMembership[]; inHistory: boolean; emptyText: string; onRenew: (item: MyMembership) => void;
}) {
  return <section aria-labelledby={id}>
    <h3 id={id}>{title}</h3>
    {items.length === 0 ? <p>{emptyText}</p> : items.map(item => <MembershipCard key={item.id} item={item} inHistory={inHistory} onRenew={onRenew} />)}
  </section>;
}

export function MyMembershipsPage() {
  const accountId = useAccountId();
  const [data, setData] = useState<PageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [transaction, setTransaction] = useState<MyTransaction | null>(null);
  const [invoice, setInvoice] = useState<MyInvoice | null>(null);
  const [detailError, setDetailError] = useState('');
  // US-19: kỳ đang mở vùng gia hạn (chép lại lúc bấm, để tải lại danh sách không làm mất vùng đang dùng).
  const [renewTarget, setRenewTarget] = useState<RenewalTarget | null>(null);
  // Số thứ tự lần tải mới nhất: kết quả cũ về muộn (ví dụ của account trước) thì bỏ qua.
  const latestLoad = useRef(0);
  // Account hiện tại, để bỏ kết quả xem giao dịch/chứng từ về sau khi đã đổi account.
  const currentAccount = useRef(accountId);
  currentAccount.current = accountId;

  const load = useCallback(async () => {
    if (!accountId) return;
    const loadNumber = ++latestLoad.current;
    setLoading(true);
    setLoadError('');
    try {
      const [memberships, sales] = await Promise.all([membershipsApi.listMemberships(), membershipsApi.listServiceSales()]);
      if (loadNumber !== latestLoad.current) return;
      setData({
        memberLinked: memberships.memberLinked, memberships: memberships.items, sales: sales.items,
        membershipsTotal: memberships.total, salesTotal: sales.total,
      });
    } catch (error) {
      // US-17-TC11: lỗi mạng/server là lỗi, KHÔNG hiện như "chưa có gói" hay "chưa liên kết".
      if (loadNumber === latestLoad.current) setLoadError(errorMessage(error, 'Không tải được dữ liệu gói tập.'));
    } finally {
      if (loadNumber === latestLoad.current) setLoading(false);
    }
  }, [accountId]);

  // US-17-TC11: đổi account thì xóa ngay dữ liệu của account trước, rồi mới tải lại.
  useEffect(() => {
    setData(null);
    setTransaction(null);
    setInvoice(null);
    setDetailError('');
    // US-19-TC12: đổi account thì đóng ngay vùng gia hạn và báo giá của account cũ.
    setRenewTarget(null);
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  // US-17-TC09: xem giao dịch của một lần mua (chỉ GET).
  async function openTransaction(id: string) {
    const account = accountId;
    setDetailError('');
    setInvoice(null);
    try {
      const result = await membershipsApi.transaction(id);
      if (currentAccount.current === account) setTransaction(result);
    } catch (error) {
      if (currentAccount.current === account) setDetailError(errorMessage(error, 'Không xem được giao dịch.'));
    }
  }

  // US-17-TC09: chứng từ hiện người mua theo snapshot của chứng từ, không theo hồ sơ hiện tại.
  async function openInvoice(id: string) {
    const account = accountId;
    setDetailError('');
    try {
      const result = await membershipsApi.invoice(id);
      if (currentAccount.current === account) setInvoice(result);
    } catch (error) {
      if (currentAccount.current === account) setDetailError(errorMessage(error, 'Không xem được chứng từ.'));
    }
  }

  // US-19-TC01: previousSaleId và planVersion lấy từ field renewal của server, không tự chọn.
  function openRenewal(item: MyMembership) {
    if (!item.renewal) return;
    setRenewTarget({ planName: item.planName, previousSaleId: item.renewal.previousSaleId, planVersion: item.renewal.planVersion });
  }

  // US-19-TC12: nguồn đã cũ → đóng vùng gia hạn và tải lại để lấy renewal mới; không tự gửi yêu cầu mới.
  function reloadAfterStale() {
    setRenewTarget(null);
    void load();
  }

  const memberships = data?.memberships ?? [];
  const sales = data?.sales ?? [];
  const pendingSales = sales.filter(sale => sale.status === 'PENDING');

  return <section className="auth-card my-memberships">
    <h2>Gói tập của tôi</h2>

    {loading && <p>Đang tải…</p>}
    {loadError && <div role="alert">{loadError} <button type="button" onClick={() => void load()}><Icon name="retry" label="Thử lại" /></button></div>}

    {/* US-17-F01, TC12: chưa liên kết là trạng thái bình thường, hướng dẫn ra quầy, không phải lỗi. */}
    {data && !data.memberLinked && <p>
      Tài khoản của bạn chưa được liên kết hồ sơ hội viên. Vui lòng liên hệ quầy lễ tân để được liên kết.
    </p>}

    {data && data.memberLinked && <>
      {memberships.length === 0 && <p>Bạn chưa có gói tập nào.</p>}
      {/* US-17-TC10: chỉ tải trang đầu; còn bản ghi chưa tải thì nói rõ, không lặng lẽ bỏ. Số lấy từ server. */}
      {data.membershipsTotal > memberships.length &&
        <p role="note">Đang hiện {memberships.length} gói gần nhất trên tổng {data.membershipsTotal}.</p>}
      <MembershipGroup title="Gói hiện hành" id="memberships-current" items={memberships.filter(isCurrent)}
        inHistory={false} emptyText="Không có gói đang hiệu lực." onRenew={openRenewal} />
      <MembershipGroup title="Gói chờ hiệu lực" id="memberships-scheduled" items={memberships.filter(isScheduled)}
        inHistory={false} emptyText="Không có gói chờ hiệu lực." onRenew={openRenewal} />
      <MembershipGroup title="Lịch sử gói" id="memberships-history"
        items={memberships.filter(item => !isCurrent(item) && !isScheduled(item))} inHistory emptyText="Chưa có gói cũ." onRenew={openRenewal} />

      {/* US-17-F02, TC06: lần mua PENDING chỉ là chờ thu, không phải gói đã có. */}
      <section aria-labelledby="sales-pending">
        <h3 id="sales-pending">Giao dịch chờ xác nhận</h3>
        {pendingSales.length === 0 ? <p>Không có giao dịch chờ xác nhận.</p> : pendingSales.map(sale =>
          <article key={sale.id} aria-label={sale.planName} className="membership-card">
            <h4>{sale.planName}</h4>
            <p>Chờ xác nhận thu{sale.amountDue ? ` – ${formatVnd(sale.amountDue)}` : ''}</p>
          </article>)}
      </section>

      <section aria-labelledby="sales-history">
        <h3 id="sales-history">Lịch sử mua</h3>
        {data.salesTotal > sales.length &&
          <p role="note">Đang hiện {sales.length} lần mua gần nhất trên tổng {data.salesTotal}.</p>}
        {/* Mỗi lần mua là một thẻ (lớp 1); giao dịch mở ra nằm ngay trong thẻ (lớp 2), chứng từ lồng trong giao dịch (lớp 3). */}
        {sales.length === 0 ? <p>Chưa có lần mua nào.</p> : sales.map(sale =>
          <article key={sale.id} aria-label={sale.planName} className="membership-card">
            <div className="card-head">
              <h4>{sale.planName}</h4>
              {sale.status && <span className={`status-badge status-${sale.status.toLowerCase()}`}>{SALE_STATUS_LABELS[sale.status]}</span>}
            </div>
            <dl className="info-grid">
              <dt>Loại</dt><dd>{OPERATION_LABELS[sale.operation]}</dd>
              <dt>Kỳ dự kiến</dt><dd>{formatDate(sale.startDate)} – {formatDate(sale.endDate)}</dd>
              {sale.amountDue && <><dt>Số tiền</dt><dd className="info-money">{formatVnd(sale.amountDue)}</dd></>}
            </dl>
            <button type="button" className="secondary" onClick={() => void openTransaction(sale.transactionId)}>Xem giao dịch</button>
            {transaction && transaction.id === sale.transactionId && <TransactionPanel transaction={transaction}
              invoice={invoice} onOpenInvoice={id => void openInvoice(id)} />}
          </article>)}
      </section>
    </>}

    {/* key: mở kỳ khác thì làm mới vùng gia hạn (xóa báo giá và key cũ). */}
    {renewTarget && <RenewalPanel key={renewTarget.previousSaleId} target={renewTarget}
      onCreated={() => void load()} onReload={reloadAfterStale} />}

    {detailError && <p role="alert">{detailError}</p>}
  </section>;
}

// Lớp 2: chi tiết giao dịch, hiện ngay trong thẻ lần mua đã bấm "Xem giao dịch".
// US-17-F04: chỉ hiện các field cho phép; không hiện mã tham chiếu, người xác minh hay ghi chú nội bộ.
function TransactionPanel({ transaction, invoice, onOpenInvoice }: {
  transaction: MyTransaction; invoice: MyInvoice | null; onOpenInvoice: (id: string) => void;
}) {
  const payment = transaction.payment;
  return <section aria-label="Chi tiết giao dịch" className="detail-panel">
    <div className="card-head">
      <h5>Giao dịch {transaction.code}</h5>
      <span className={`status-badge status-${transaction.status.toLowerCase()}`}>{SALE_STATUS_LABELS[transaction.status]}</span>
    </div>
    <dl className="info-grid">
      <dt>Số tiền phải trả</dt><dd className="info-money">{formatVnd(transaction.amountDue)}</dd>
      {payment && <>
        <dt>Đã thu</dt><dd>{formatVnd(payment.amount)} bằng {payment.method === 'CASH' ? 'tiền mặt' : 'chuyển khoản'}</dd>
        {payment.paidAt && <><dt>Thời điểm thu</dt><dd>{formatDateTime(payment.paidAt)}</dd></>}
      </>}
    </dl>
    {transaction.invoiceId && <button type="button" className="secondary" onClick={() => onOpenInvoice(transaction.invoiceId!)}>Xem chứng từ</button>}
    {invoice && invoice.id === transaction.invoiceId && <InvoicePanel invoice={invoice} />}
  </section>;
}

// Lớp 3: chứng từ dạng hóa đơn, lồng trong khung giao dịch.
// US-17-TC09: người mua lấy theo snapshot của chứng từ; buyerLabel đổi chuỗi JSON thành "Tên · Mã HV · SĐT".
function InvoicePanel({ invoice }: { invoice: MyInvoice }) {
  return <section aria-label="Chứng từ" className="receipt-panel">
    <h5>Chứng từ {invoice.invoiceNo}</h5>
    <dl className="info-grid">
      <dt>Ngày lập</dt><dd>{formatDateTime(invoice.issuedAt)}</dd>
      <dt>Người mua</dt><dd>{buyerLabel(invoice.buyer)}</dd>
      <dt>Tổng tiền</dt><dd className="info-money">{formatVnd(invoice.totalAmount)}</dd>
    </dl>
  </section>;
}
