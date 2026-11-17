// Tầng giao diện – trang (US-19 bước 3): vùng "Gia hạn gói" mở từ nút "Gia hạn" trên trang /member/memberships.
// Chọn cách trả, xem trước, xác nhận; số tiền và ngày dự kiến lấy từ server, React không tự tính (US-19-F02).
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { PaymentInstructions, PaymentMethod } from '../service-registrations/service-registrations.api';
import { renewalsApi, type RenewalInput, type RenewalQuote, type RenewalResult } from './renewals.api';

// Kỳ được gia hạn: tên gói để hiển thị và dữ liệu renewal server trả trong /me/memberships.
export interface RenewalTarget {
  planName: string;
  previousSaleId: string;
  planVersion: number;
}

// "2026-12-01" → "01/12/2026" (tách chuỗi, không qua Date nên không lệch múi giờ).
function formatDate(value: string): string {
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

// "300000" → "300.000 đ" (xử lý chuỗi, không đổi sang Number).
const formatVnd = (value: string) => `${value.replace(/\B(?=(\d{3})+(?!\d))/g, '.')} đ`;

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : undefined);

// US-19-TC12: kỳ nguồn/gói đổi sau lúc tải trang → phải tải lại, không tự chọn nguồn mới.
const STALE_CODES = ['SOURCE_NOT_LATEST', 'SOURCE_NOT_ELIGIBLE', 'PLAN_CHANGED'];

// US-19-TC03: lý do không gia hạn được, theo mã server trả (blockingCode hoặc mã lỗi 409).
const REASON_LABELS: Record<string, string> = {
  PENDING_SALE_EXISTS: 'Bạn đang có một yêu cầu cùng loại chờ xác nhận thu. Hãy chờ quầy xác nhận hoặc hủy yêu cầu đó trước.',
  PLAN_NOT_AVAILABLE: 'Gói này đã ngừng bán nên chưa gia hạn được. Vui lòng liên hệ quầy để chọn gói khác.',
  MEMBER_PROFILE_REQUIRED: 'Tài khoản chưa được liên kết hồ sơ hội viên. Vui lòng liên hệ quầy lễ tân.',
  RECEIVING_ACCOUNTS_NOT_CONFIGURED: 'Phòng tập chưa nhận chuyển khoản. Hãy chọn "Tiền mặt tại quầy".',
};

// Lỗi mạng hoặc 5xx: chưa biết server đã ghi nhận chưa, nên giữ key để "Thử lại" (US-19-TC12).
function isUnknownOutcome(error: unknown) {
  if (!(error instanceof ApiError) || error.status === undefined) return true;
  return error.status >= 500 && error.code !== 'RECEIVING_ACCOUNTS_NOT_CONFIGURED';
}

function messageOf(error: unknown, fallback: string) {
  const code = codeOf(error);
  if (code && REASON_LABELS[code]) return REASON_LABELS[code];
  return error instanceof ApiError && error.message ? error.message : fallback;
}

export function RenewalPanel({ target, onCreated, onReload }: {
  target: RenewalTarget;
  onCreated: () => void;   // tải lại danh sách gói và lần mua của trang
  onReload: () => void;    // đóng vùng gia hạn và tải lại dữ liệu mới
}) {
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [quote, setQuote] = useState<RenewalQuote | null>(null);
  const [quotedInput, setQuotedInput] = useState<RenewalInput | null>(null);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RenewalResult | null>(null);
  const [guide, setGuide] = useState<PaymentInstructions | null>(null);
  // US-19-TC09, TC12: key gắn với đúng body đã gửi; body đổi (ví dụ đổi cách trả) thì tạo key mới.
  const pendingKey = useRef<{ payload: string; key: string } | null>(null);
  // Vùng đã đóng (đổi account, tải lại) thì bỏ qua kết quả về muộn.
  // Gán true khi mount: StrictMode (main.tsx) chạy mount → cleanup → mount lại, nếu chỉ gán false thì ref kẹt ở false.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Đổi cách trả thì báo giá cũ không còn đúng → phải xem trước lại.
  function changeMethod(value: PaymentMethod) {
    setMethod(value);
    resetQuote();
  }

  // Xóa báo giá và thông báo lỗi cũ.
  function resetQuote() {
    setQuote(null);
    setQuotedInput(null);
    setError('');
    setStale(false);
    setCanRetry(false);
  }

  // Server đã từ chối chắc chắn: nguồn cũ → nút "Tải lại"; còn lại hiện lý do.
  function showRejection(rejection: unknown) {
    setStale(STALE_CODES.includes(codeOf(rejection) ?? ''));
    setError(STALE_CODES.includes(codeOf(rejection) ?? '')
      ? 'Thông tin gói đã thay đổi. Bấm "Tải lại" để xem dữ liệu mới rồi xác nhận lại.'
      : messageOf(rejection, 'Không gửi được yêu cầu gia hạn.'));
  }

  // US-19-TC01: Xem trước gửi ĐÚNG 3 field; chưa tạo gì.
  async function handlePreview() {
    resetQuote();
    const input: RenewalInput = { previousSaleId: target.previousSaleId, planVersion: target.planVersion, preferredPaymentMethod: method };
    try {
      const preview = await renewalsApi.preview(input);
      if (!alive.current) return;
      setQuote(preview);
      setQuotedInput(input);
    } catch (rejection) {
      // US-19-TC12: lỗi mạng khi xem trước chỉ báo lỗi, không hiện giá 0 hay "miễn phí".
      if (alive.current) showRejection(rejection);
    }
  }

  // US-19-TC08, TC09, TC12: gửi đúng nội dung vừa xem trước kèm Idempotency-Key.
  async function handleConfirm() {
    if (!quotedInput || submitting) return;
    setSubmitting(true);
    setError('');
    setCanRetry(false);
    const payload = JSON.stringify(quotedInput);
    if (pendingKey.current?.payload !== payload) pendingKey.current = { payload, key: crypto.randomUUID() };
    try {
      const created = await renewalsApi.create(quotedInput, pendingKey.current.key);
      if (!alive.current) return;
      pendingKey.current = null;
      setQuote(null);
      setQuotedInput(null);
      setResult(created);
      // US-19-TC08: giá 0 đã hoàn tất, không cần hướng dẫn thanh toán.
      if (created.transactionStatus === 'PENDING' && created.amountDue !== '0') void loadGuide(created.transactionId);
      onCreated();
    } catch (rejection) {
      if (!alive.current) return;
      if (isUnknownOutcome(rejection)) {
        // US-19-TC12: giữ báo giá và key; "Thử lại" gửi lại CÙNG key nên server không tạo hai kỳ.
        setError(`${messageOf(rejection, 'Không gửi được yêu cầu gia hạn.')} Chưa rõ yêu cầu đã được ghi nhận chưa, bấm "Thử lại".`);
        setCanRetry(true);
      } else {
        pendingKey.current = null;
        setQuote(null);
        setQuotedInput(null);
        showRejection(rejection);
      }
    } finally {
      if (alive.current) setSubmitting(false);
    }
  }

  async function loadGuide(transactionId: string) {
    try {
      const instructions = await renewalsApi.paymentInstructions(transactionId);
      if (alive.current) setGuide(instructions);
    } catch {
      // Không tải được hướng dẫn thì vẫn còn mã giao dịch để đọc cho quầy.
    }
  }

  return <section aria-labelledby="renewal-title" className="renewal-panel">
    <h3 id="renewal-title">Gia hạn gói</h3>
    <p>{target.planName}</p>

    {!result && <>
      <fieldset>
        <legend>Cách thanh toán dự kiến</legend>
        <label><input type="radio" name="renewal-method" checked={method === 'CASH'} onChange={() => changeMethod('CASH')} />
          Tiền mặt tại quầy</label>
        <label><input type="radio" name="renewal-method" checked={method === 'TRANSFER'} onChange={() => changeMethod('TRANSFER')} />
          Chuyển khoản</label>
      </fieldset>
      <button type="button" onClick={() => void handlePreview()}>Xem trước</button>

      {/* US-19-TC01: số tiền và ngày dự kiến đều do server tính. */}
      {quote && <div>
        <p>Số tiền: {formatVnd(quote.amountDue)}</p>
        <p>Kỳ mới dự kiến: {formatDate(quote.expectedStartDate)} – {formatDate(quote.expectedEndDate)}</p>
        <p>Ngày thực tế chốt khi quầy xác nhận thu.</p>
        {quote.canProceed
          ? <button type="button" disabled={submitting} onClick={() => void handleConfirm()}>Xác nhận gia hạn</button>
          // US-19-TC03: không đủ điều kiện thì nói lý do, không có nút xác nhận.
          : <p>{(quote.blockingCode && REASON_LABELS[quote.blockingCode]) || 'Hiện chưa thể gia hạn gói này.'}</p>}
      </div>}

      {error && <div role="alert">
        {error}
        {stale && <button type="button" onClick={onReload}>Tải lại</button>}
        {canRetry && <button type="button" disabled={submitting} onClick={() => void handleConfirm()}>Thử lại</button>}
      </div>}
    </>}

    {/* US-19-TC12: PENDING chỉ là chờ thu – không hiện ngày hết hạn mới như quyền đã cấp. */}
    {result && <section aria-labelledby="renewal-result-title">
      <h4 id="renewal-result-title">Kết quả gia hạn</h4>
      <p>Mã giao dịch: {result.transactionCode}</p>
      {result.transactionStatus === 'PENDING'
        ? <p>Chờ xác nhận thu – {formatVnd(result.amountDue)}. Gói mới chỉ có hiệu lực sau khi quầy xác nhận đã thu đủ.</p>
        : <p>Gia hạn đã hoàn tất. Kỳ mới đã có trong danh sách gói của bạn.</p>}
      {guide && <div>
        <p>{guide.cashInstruction}</p>
        {guide.transferOptions?.map(option => <p key={option.receivingAccountCode}>
          {option.bankName} – {option.accountNumber} – {option.accountName}. Nội dung chuyển khoản: {option.transferContent}
        </p>)}
      </div>}
    </section>}
  </section>;
}
