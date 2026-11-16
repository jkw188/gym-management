import { useRef, useState, type FormEvent } from 'react';
import { addDays, vietnamDate, vietnamTime } from '../shifts/shift-time';
import { adminClassesApi, type AdminClass, type ClassCommand, type ClassInput } from './admin-classes.api';
import type { Subject } from './classes.api';
import { ClassTrainerPicker } from './ClassTrainerPicker';

export const classConflictLabels: Record<string, string> = {
  SESSION_OVERLAP: 'PT bận lớp đã công bố.', BOOKING_CONFLICT: 'PT bận lịch đặt riêng.', TRAINER_UNAVAILABLE: 'PT hoặc tài khoản PT không khả dụng.',
};
export function ClassForm({ initial, subjects, disabled, onSubmit, onClose }: {
  initial?: AdminClass; subjects: Subject[]; disabled: boolean; onSubmit: (command: ClassCommand) => void; onClose: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [trainerId, setTrainerId] = useState(initial?.trainerId ?? '');
  const [subjectCode, setSubjectCode] = useState(initial?.subjectCode ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [day, setDay] = useState(initial ? vietnamDate(new Date(initial.startAt)) : vietnamDate(new Date()));
  const [start, setStart] = useState(initial ? vietnamTime(initial.startAt) : '08:00');
  const [end, setEnd] = useState(initial ? vietnamTime(initial.endAt) : '08:45');
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<string[]>([]);
  const [previewTime, setPreviewTime] = useState('');
  const [error, setError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const previewRound = useRef(0);
  function input(): ClassInput {
    return { title: title.trim(), trainerId, subjectCode, location: location.trim(), startAt: `${day}T${start}:00+07:00`,
      endAt: `${end === '00:00' ? addDays(day, 1) : day}T${end}:00+07:00` };
  }
  function changed() { previewRound.current++; setPreview([]); setPreviewTime(''); setConfirmed(false); }
  async function showPreview() {
    const round = ++previewRound.current;
    setPreviewing(true); setError(''); setPreviewTime(''); setPreview([]);
    try {
      const result = await adminClassesApi.preview({ ...input(), ...(initial ? { sessionId: initial.id } : {}) });
      if (round !== previewRound.current) return;
      setPreview(result.conflictCodes);
      setPreviewTime(`${vietnamDate(new Date(result.startAt))} ${vietnamTime(result.startAt)} – ${vietnamDate(new Date(result.endAt))} ${vietnamTime(result.endAt)} (giờ Việt Nam)`);
    } catch (failure) { if (round === previewRound.current) setError(failure instanceof Error ? failure.message : 'Không xem trước được.'); }
    finally { setPreviewing(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || !title.trim() || !location.trim() || initial?.status === 'PUBLISHED' && !confirmed) return;
    onSubmit(initial ? { operation: 'PUBLIC_SESSION_UPDATE', id: initial.id, input: { ...input(), version: initial.version } }
      : { operation: 'PUBLIC_SESSION_CREATE', input: input() });
  }
  return <form aria-label="Thông tin lớp" onSubmit={submit}>
    <h3>{initial ? 'Sửa lớp' : 'Tạo lớp nháp'}</h3>
    <fieldset disabled={disabled} onChange={changed}>
      <label htmlFor="class-title">Tên lớp</label><input id="class-title" required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} />
      <ClassTrainerPicker value={trainerId} name={initial?.trainerName} required onChange={setTrainerId} />
      <label htmlFor="class-form-subject">Bộ môn của lớp</label><select id="class-form-subject" required value={subjectCode} onChange={e => setSubjectCode(e.target.value)}>
        <option value="">Chọn bộ môn</option>{subjects.map(subject => <option key={subject.code} value={subject.code}>{subject.label}</option>)}</select>
      {subjectCode === 'OTHER' && <p>Kiểm tra lại bộ môn trước khi công bố, đặc biệt với lớp được chuyển từ dữ liệu cũ.</p>}
      <label htmlFor="class-location">Địa điểm</label><input id="class-location" required maxLength={120} value={location} onChange={e => setLocation(e.target.value)} />
      <label htmlFor="class-day">Ngày Việt Nam</label><input id="class-day" type="date" required value={day} onChange={e => setDay(e.target.value)} />
      <label htmlFor="class-start">Giờ bắt đầu (VN)</label><input id="class-start" type="time" step="60" required value={start} onChange={e => setStart(e.target.value)} />
      <label htmlFor="class-end">Giờ kết thúc (VN)</label><input id="class-end" type="time" step="60" required value={end} onChange={e => setEnd(e.target.value)} />
      <p>Kết thúc 00:00 là đầu ngày kế tiếp. Lớp có thể ngoài ca PT; máy chủ kiểm tra lịch bận khi công bố.</p>
      <button type="button" disabled={previewing} onClick={() => void showPreview()}>Xem trước lịch bận</button>
      {previewing && <p role="status">Đang kiểm tra lịch bận…</p>}
      {previewTime && <div role="status"><p>{previewTime}</p>{preview.length ? preview.map(code => <p key={code}>{classConflictLabels[code] ?? code}</p>) : <p>Chưa phát hiện lịch bận. Kết quả sẽ được kiểm tra lại khi lưu/công bố.</p>}</div>}
      {error && <p role="alert">{error}</p>}
    </fieldset>
    {initial?.status === 'PUBLISHED' && <label><input type="checkbox" checked={confirmed} disabled={disabled}
      onChange={e => setConfirmed(e.target.checked)} /> Tôi xác nhận thay đổi lớp đang công khai, bao gồm thời gian hiển thị cho mọi người.</label>}
    <div className="user-actions"><button disabled={disabled || !subjects.length || initial?.status === 'PUBLISHED' && !confirmed}>Lưu {initial ? 'thay đổi lớp' : 'lớp nháp'}</button>
      <button type="button" disabled={disabled} onClick={onClose}>Đóng form</button></div>
  </form>;
}
