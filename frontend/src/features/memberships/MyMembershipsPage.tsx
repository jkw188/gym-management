// Tầng giao diện – trang (US-17 bước 3): trang /member/memberships chỉ đọc – gói hiện hành, chờ hiệu lực, lịch sử,
// giao dịch chờ xác nhận, lịch sử mua và chứng từ của chính Member. timeState và số buổi lấy từ server, React không tự tính.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useAccountId } from '../notifications/inbox-signals';
import {
  membershipsApi, type MyInvoice, type MyMembership, type MyServiceSale, type MyTransaction, type SaleOperation,
  type TransactionStatus,
} from './memberships.api';

interface PageData { memberLinked: boolean; memberships: MyMembership[]; sales: MyServiceSale[] }

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

function MembershipCard({ item, inHistory }: { item: MyMembership; inHistory: boolean }) {
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
  </article>;
}

function MembershipGroup({ title, id, items, inHistory, emptyText }: {
  title: string; id: string; items: MyMembership[]; inHistory: boolean; emptyText: string;
}) {
  return <section aria-labelledby={id}>
    <h3 id={id}>{title}</h3>
    {items.length === 0 ? <p>{emptyText}</p> : items.map(item => <MembershipCard key={item.id} item={item} inHistory={inHistory} />)}
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
      setData({ memberLinked: memberships.memberLinked, memberships: memberships.items, sales: sales.items });
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

  const memberships = data?.memberships ?? [];
  const sales = data?.sales ?? [];
  const pendingSales = sales.filter(sale => sale.status === 'PENDING');

  return <section className="auth-card my-memberships">
    <h2>Gói tập của tôi</h2>

    {loading && <p>Đang tải…</p>}
    {loadError && <div role="alert">{loadError} <button type="button" onClick={() => void load()}>Thử lại</button></div>}

    {/* US-17-F01, TC12: chưa liên kết là trạng thái bình thường, hướng dẫn ra quầy, không phải lỗi. */}
    {data && !data.memberLinked && <p>
      Tài khoản của bạn chưa được liên kết hồ sơ hội viên. Vui lòng liên hệ quầy lễ tân để được liên kết.
    </p>}

    {data && data.memberLinked && <>
      {memberships.length === 0 && <p>Bạn chưa có gói tập nào.</p>}
      <MembershipGroup title="Gói hiện hành" id="memberships-current" items={memberships.filter(isCurrent)}
        inHistory={false} emptyText="Không có gói đang hiệu lực." />
      <MembershipGroup title="Gói chờ hiệu lực" id="memberships-scheduled" items={memberships.filter(isScheduled)}
        inHistory={false} emptyText="Không có gói chờ hiệu lực." />
      <MembershipGroup title="Lịch sử gói" id="memberships-history"
        items={memberships.filter(item => !isCurrent(item) && !isScheduled(item))} inHistory emptyText="Chưa có gói cũ." />

      {/* US-17-F02, TC06: lần mua PENDING chỉ là chờ thu, không phải gói đã có. */}
      <section aria-labelledby="sales-pending">
        <h3 id="sales-pending">Giao dịch chờ xác nhận</h3>
        {pendingSales.length === 0 ? <p>Không có giao dịch chờ xác nhận.</p> : pendingSales.map(sale =>
          <article key={sale.id} aria-label={sale.planName}>
            <h4>{sale.planName}</h4>
            <p>Chờ xác nhận thu{sale.amountDue ? ` – ${formatVnd(sale.amountDue)}` : ''}</p>
          </article>)}
      </section>

      <section aria-labelledby="sales-history">
        <h3 id="sales-history">Lịch sử mua</h3>
        {sales.length === 0 ? <p>Chưa có lần mua nào.</p> : sales.map(sale =>
          <article key={sale.id} aria-label={sale.planName}>
            <h4>{sale.planName}</h4>
            <p>{OPERATION_LABELS[sale.operation]}{sale.status ? ` – ${SALE_STATUS_LABELS[sale.status]}` : ''}</p>
            <p>Kỳ dự kiến: {formatDate(sale.startDate)} – {formatDate(sale.endDate)}</p>
            {sale.amountDue && <p>Số tiền: {formatVnd(sale.amountDue)}</p>}
            <button type="button" onClick={() => void openTransaction(sale.transactionId)}>Xem giao dịch</button>
          </article>)}
      </section>
    </>}

    {detailError && <p role="alert">{detailError}</p>}

    {/* US-17-F04: chỉ hiện các field cho phép; không hiện mã tham chiếu, người xác minh hay ghi chú nội bộ. */}
    {transaction && <section aria-label="Chi tiết giao dịch">
      <h3>Giao dịch {transaction.code}</h3>
      <p>Trạng thái: {SALE_STATUS_LABELS[transaction.status]}</p>
      <p>Số tiền phải trả: {formatVnd(transaction.amountDue)}</p>
      {transaction.payment && <p>
        Đã thu {formatVnd(transaction.payment.amount)} bằng {transaction.payment.method === 'CASH' ? 'tiền mặt' : 'chuyển khoản'}
        {transaction.payment.paidAt ? ` lúc ${formatDateTime(transaction.payment.paidAt)}` : ''}
      </p>}
      {transaction.invoiceId && <button type="button" onClick={() => void openInvoice(transaction.invoiceId!)}>Xem chứng từ</button>}
    </section>}

    {invoice && <section aria-label="Chứng từ">
      <h3>Chứng từ {invoice.invoiceNo}</h3>
      <p>Ngày lập: {formatDateTime(invoice.issuedAt)}</p>
      <p>Tổng tiền: {formatVnd(invoice.totalAmount)}</p>
      <p>Người mua: {invoice.buyer}</p>
    </section>}
  </section>;
}
