// Tầng giao diện – thành phần của trang /member/pt-bookings (US-65 bước 3): Member gửi đánh giá buổi PT đã hoàn tất
// (chọn sao, nhận xét, xem trước, xác nhận) và xem lại đánh giá đã gửi. Đánh giá không sửa/xóa sau khi gửi (US-65-F03).
// Được đánh giá hay không là gợi ý reviewState của server; server kiểm lại khi gửi, React không tự quyết theo gói hay giờ.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { ptBookingsApi, REVIEW_COMMENT_MAX, type CreateReviewInput, type MyPtBooking, type PtReview } from './pt-bookings.api';
import { formatAsOf, formatDate, formatRange } from './pt-booking-format';

// US-65 spec mục 2 (UI): mỗi mức sao có nhãn chữ, không chỉ con số.
const RATING_LABELS: Record<number, string> = { 1: 'Rất tệ', 2: 'Tệ', 3: 'Bình thường', 4: 'Tốt', 5: 'Rất tốt' };
const RATINGS = [1, 2, 3, 4, 5];
const ratingText = (rating: number) => `${rating} sao – ${RATING_LABELS[rating] ?? ''}`;

const errorMessage = (error: unknown, fallback: string) => (error instanceof ApiError && error.message ? error.message : fallback);

// create: mở từ nút "Đánh giá" (buổi ELIGIBLE). view: mở từ nút "Xem đánh giá" (buổi SUBMITTED).
export type ReviewMode = 'create' | 'view';

// Các bước của form gửi: nhập → xem trước → đóng form (đã gửi hoặc server từ chối).
type Step = 'input' | 'preview' | 'closed';

interface Props {
  booking: MyPtBooking;
  mode: ReviewMode;
  // Tải lại "Lịch của tôi" để thẻ buổi hiện reviewState mới của server.
  onReload: () => Promise<void>;
  onClose: () => void;
}

// Hiển thị một đánh giá đã gửi: chỉ đọc, không có nút Sửa/Xóa hay ô nhập (US-65-TC07).
// Nhận xét in bằng {} của React nên HTML hiện đúng dạng chữ, không thành thẻ (US-65-TC06).
function ReviewView({ review, onClose }: { review: PtReview; onClose: () => void }) {
  return <section aria-labelledby="pt-review-view">
    <h4 id="pt-review-view">Đánh giá của bạn</h4>
    <p>{ratingText(review.rating)}</p>
    {review.comment ? <p className="review-comment">{review.comment}</p> : <p>(Không có nhận xét)</p>}
    {/* US-65-F04: ngày gửi là giờ server lúc gửi, hiển thị theo giờ Việt Nam. */}
    <p>Gửi lúc {formatAsOf(review.createdAt)}</p>
    <button type="button" onClick={onClose}><Icon name="close" label="Đóng" /></button>
  </section>;
}

export function PtReviewPanel({ booking, mode, onReload, onClose }: Props) {
  // Dữ liệu Member đang nhập.
  const [step, setStep] = useState<Step>(mode === 'create' ? 'input' : 'closed');
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');

  // Kết quả: review gốc server trả, trạng thái tải/gửi và thông báo.
  const [review, setReview] = useState<PtReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  // US-65-TC01: chặn bấm kép ngay lập tức (state của React chỉ cập nhật ở lần render sau).
  const sendingNow = useRef(false);
  // US-65-TC11: Idempotency-Key gắn với đúng dữ liệu gửi. Mất phản hồi/503 rồi bấm lại cùng dữ liệu → dùng LẠI key cũ.
  const pendingKey = useRef<{ payload: string; key: string } | null>(null);

  // US-65-F02: nhận xét được kiểm theo độ dài SAU khi bỏ khoảng trắng hai đầu (server kiểm lại).
  const trimmedComment = comment.trim();
  const canPreview = rating !== null && trimmedComment.length <= REVIEW_COMMENT_MAX;

  // Tải review đã gửi từ server và hiện trong "Đánh giá của bạn". Trả true nếu server có review.
  // useCallback: hàm chỉ đổi khi đổi buổi (booking.id) hoặc đổi hàm tải lịch, để effect bên dưới khai báo đủ phụ thuộc.
  const loadReview = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError('');
    try {
      const result = await ptBookingsApi.getOwnReview(booking.id);
      if (result.review) {
        setReview(result.review);
        return true;
      }
      // US-65-TC07: reviewState trên thẻ chỉ là gợi ý; server nói chưa có review nghĩa là gợi ý đã cũ
      // → tải lại lịch để thẻ hiện đúng reviewState mới của server.
      setError('Buổi này chưa có đánh giá. Lịch đã được tải lại.');
      await onReload();
      return false;
    } catch (loadError) {
      // US-65-TC12: lỗi mạng là lỗi, không hiện như đã gửi thành công.
      setError(errorMessage(loadError, 'Không tải được đánh giá.'));
      return false;
    } finally {
      setLoading(false);
    }
  }, [booking.id, onReload]);

  // US-65-TC07: "Xem đánh giá" tải bản gốc khi mở. Phụ thuộc khai báo đủ (mode, loadReview) nên đổi buổi thì tải lại
  // đúng review của buổi mới, không dựa vào việc trang cha đặt key cho PtReviewPanel.
  useEffect(() => {
    if (mode === 'view') void loadReview();
  }, [mode, loadReview]);

  // US-65-TC01, TC02, TC04, TC07, TC11: gửi đánh giá sau khi Member xác nhận ở bảng xem trước.
  async function submit() {
    if (rating === null || sendingNow.current) return;
    sendingNow.current = true;
    setSending(true);
    setSuccess('');
    setError('');

    // US-65-TC02: body CHỈ {rating, comment}; không gửi memberId/trainerId/status/createdAt.
    const input: CreateReviewInput = { rating, comment: trimmedComment };
    const payload = JSON.stringify({ bookingId: booking.id, ...input });
    if (pendingKey.current?.payload !== payload) pendingKey.current = { payload, key: crypto.randomUUID() };

    try {
      const created = await ptBookingsApi.createReview(booking.id, input, pendingKey.current.key);
      // Thành công: bỏ key, đóng form, hiện ĐÚNG bản server trả (đã chuẩn hóa), không dùng chữ đang gõ.
      pendingKey.current = null;
      setStep('closed');
      setReview(created);
      setSuccess('Đã gửi đánh giá.');
      await onReload();
    } catch (sendError) {
      if (sendError instanceof ApiError && sendError.status === 409 && sendError.code === 'REVIEW_ALREADY_EXISTS') {
        // US-65-TC07: buổi đã được đánh giá (ví dụ gửi từ máy khác) → tải và hiện bản đã gửi, không gửi POST khác.
        pendingKey.current = null;
        setStep('closed');
        // Không có review (hiếm) thì loadReview đã tự tải lại lịch; có review thì tải lại lịch để thẻ thành SUBMITTED.
        if (await loadReview()) await onReload();
      } else if (sendError instanceof ApiError && sendError.status === 409) {
        // US-65-TC04: buổi không còn COMPLETED (vừa bị Admin mở lại) → báo lỗi, đóng form, tải lại lịch.
        pendingKey.current = null;
        setStep('closed');
        setError(sendError.code === 'BOOKING_NOT_COMPLETED'
          ? 'Buổi tập không còn ở trạng thái hoàn tất nên chưa đánh giá được. Lịch đã được tải lại.'
          : `${errorMessage(sendError, 'Không gửi được đánh giá.')} Lịch đã được tải lại.`);
        await onReload();
      } else {
        // US-65-TC11: mất phản hồi hoặc 503 → chưa biết kết quả: giữ bảng xem trước và key, KHÔNG tự gửi lại.
        setError(`${errorMessage(sendError, 'Không gửi được đánh giá.')} Bấm "Xác nhận gửi" để thử lại.`);
      }
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
  }

  return <>
    {/* US-65-TC01: form đánh giá – tên PT, thời gian buổi, 5 mức sao kèm nhãn, nhận xét không bắt buộc. */}
    {step !== 'closed' && <section aria-labelledby="pt-review-form">
      <h4 id="pt-review-form">Đánh giá buổi PT</h4>
      <p>PT: {booking.trainerName}</p>
      <p>Buổi: {formatRange(booking.startAt, booking.endAt)} ngày {formatDate(booking.startAt)}</p>

      {step === 'input' && <>
        <fieldset>
          <legend>Số sao</legend>
          {RATINGS.map(value => <label key={value}>
            <input type="radio" name="pt-review-rating" checked={rating === value} onChange={() => setRating(value)} /> {ratingText(value)}
          </label>)}
        </fieldset>
        <label>Nhận xét (không bắt buộc)
          <textarea value={comment} onChange={event => setComment(event.target.value)} />
        </label>
        <p className="hint">{trimmedComment.length}/{REVIEW_COMMENT_MAX} ký tự</p>
        {/* US-65-TC05: chưa chọn sao hoặc nhận xét quá 1000 ký tự thì khóa nút. */}
        <button type="button" disabled={!canPreview} onClick={() => setStep('preview')}>Xem trước</button>
        {' '}<button type="button" onClick={onClose}><Icon name="close" label="Đóng" /></button>
      </>}

      {/* US-65-TC01: xem trước nội dung sẽ gửi và cảnh báo không sửa được sau khi gửi. */}
      {step === 'preview' && rating !== null && <>
        <p>{ratingText(rating)}</p>
        {trimmedComment ? <p className="review-comment">{trimmedComment}</p> : <p>(Không có nhận xét)</p>}
        <p><strong>Lưu ý: sau khi gửi bạn không thể sửa hay xóa đánh giá này.</strong></p>
        {/* US-65-TC01: đang gửi thì khóa nút để không gửi kép. */}
        <button type="button" disabled={sending} onClick={() => void submit()}>Xác nhận gửi</button>
        {' '}<button type="button" disabled={sending} onClick={() => setStep('input')}>Quay lại</button>
      </>}
    </section>}

    {loading && <p>Đang tải đánh giá…</p>}
    {success && <p role="status">{success}</p>}
    {error && <p role="alert">{error}</p>}
    {review && <ReviewView review={review} onClose={onClose} />}
  </>;
}
