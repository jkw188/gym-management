// Tầng giao diện – thành phần dùng chung: icon SVG vẽ tay cho nút (tìm kiếm, tải lại, hiện/ẩn mật khẩu, chuyển trang…).
// Chữ của nút vẫn nằm trong thẻ ẩn "sr-only" để trình đọc màn hình và test vẫn tìm được nút theo tên.

export type IconName = 'search' | 'filter' | 'retry' | 'eye' | 'eyeOff' | 'prev' | 'next' | 'close' | 'logout';

// Mỗi icon là vài nét vẽ (thuộc tính d của <path>) trên khung 24x24, nét dày 2px.
const iconPaths: Record<IconName, string[]> = {
  search: ['M18 11a7 7 0 1 1-14 0a7 7 0 1 1 14 0z', 'M21 21l-5-5'],               // kính lúp
  filter: ['M3 5h18l-7 8v6l-4 2v-8z'],                                            // cái phễu
  retry: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'],                                 // mũi tên xoay vòng
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0z'],
  eyeOff: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0z', 'M3 3l18 18'],
  prev: ['M15 18l-6-6 6-6'],                                                       // mũi tên trái
  next: ['M9 18l6-6-6-6'],                                                         // mũi tên phải
  close: ['M18 6L6 18', 'M6 6l12 12'],                                             // dấu X
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'], // cửa và mũi tên ra
};

// showLabel = false: chỉ hiện icon, chữ bị ẩn nhưng rê chuột vào sẽ thấy chú thích (title).
// showLabel = true: hiện cả icon và chữ (dùng cho nút có tên dài, cần đọc mới hiểu).
export function Icon({ name, label, showLabel = false }: { name: IconName; label: string; showLabel?: boolean }) {
  return <span className="icon-label" title={showLabel ? undefined : label}>
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {iconPaths[name].map(d => <path key={d} d={d} />)}
    </svg>
    <span className={showLabel ? undefined : 'sr-only'}>{label}</span>
  </span>;
}
