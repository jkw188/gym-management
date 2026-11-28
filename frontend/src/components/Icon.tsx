// Tầng giao diện – thành phần dùng chung: icon SVG vẽ tay cho nút (tìm kiếm, tải lại, hiện/ẩn mật khẩu, chuyển trang…).
// Chữ của nút vẫn nằm trong thẻ ẩn "sr-only" để trình đọc màn hình và test vẫn tìm được nút theo tên.

export type IconName = 'search' | 'filter' | 'retry' | 'eye' | 'eyeOff' | 'prev' | 'next' | 'close' | 'logout' | 'bell' | 'back'
  | 'menu' | 'home' | 'weights' | 'users' | 'calendar' | 'cart' | 'chart' | 'box' | 'plus' | 'down'
  | 'user' | 'cash' | 'clock' | 'bag' | 'refund' | 'document' | 'lock' | 'trophy' | 'bolt' | 'arrow';

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
  bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],   // cái chuông
  back: ['M19 12H5', 'M12 19l-7-7 7-7'],                                           // mũi tên quay lại
  menu: ['M4 6h16M4 12h16M4 18h16'],
  home: ['M3 10l9-7 9 7v10H3z', 'M9 20v-7h6v7'],
  weights: ['M2 10v4m20-4v4M5 7v10m14-10v10M8 8v8m8-8v8M8 12h8'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4', 'M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm4-4a4 4 0 0 1 0 8'],
  calendar: ['M4 5h16v16H4z', 'M8 3v4m8-4v4M4 10h16m-12 5h2m4 0h2'],
  cart: ['M2 3h3l3 12h11l3-9H6', 'M9 20h.01m9-.01h.01'],
  chart: ['M3 3v18h18M8 16v-3m5 3V9m5 7V5'],
  box: ['M3 7l9-4 9 4v10l-9 4-9-4z', 'M3 7l9 4 9-4m-9 4v10'],
  plus: ['M12 5v14M5 12h14'],
  down: ['M6 9l6 6 6-6'],
  user: ['M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0', 'M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2'],
  cash: ['M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0M6 12h1m10 0h1'],
  clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', 'M12 7v5l3 2'],
  bag: ['M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18'],
  refund: ['M9 4H4v5m0-5 8 8m5 0h4v8h-8v-4'],
  document: ['M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z', 'M13 3v7h7M8 14h8m-8 3h8'],
  lock: ['M4 12a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'M8 10V7a4 4 0 0 1 8 0v3'],
  trophy: ['M8 21h8m-4-4v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H3v2a4 4 0 0 0 4 4m10-6h4v2a4 4 0 0 1-4 4'],
  bolt: ['M13 2 5 14h6l-1 8 9-12h-6z'],
  arrow: ['M4 12h15m-6-6 6 6-6 6'],
};

// showLabel = false: chỉ hiện icon, chữ bị ẩn nhưng rê chuột vào sẽ thấy chú thích (title).
// showLabel = true: hiện cả icon và chữ (dùng cho nút có tên dài, cần đọc mới hiểu).
export function Icon({ name, label, showLabel = false }: { name: IconName; label?: string; showLabel?: boolean }) {
  return <span className="icon-label" title={showLabel ? undefined : label}>
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {iconPaths[name].map(d => <path key={d} d={d} />)}
    </svg>
    {label && <span className={showLabel ? undefined : 'sr-only'}>{label}</span>}
  </span>;
}
