// Tầng giao diện – thành phần dùng chung: icon SVG vẽ tay cho nút (tìm kiếm, tải lại, hiện/ẩn mật khẩu, chuyển trang…).
// Chữ của nút vẫn nằm trong thẻ ẩn "sr-only" để trình đọc màn hình và test vẫn tìm được nút theo tên.

export type IconName = 'search' | 'filter' | 'retry' | 'eye' | 'eyeOff' | 'prev' | 'next' | 'close' | 'logout' | 'bell' | 'back'
  // Icon của menu bên trái (khung trang khi đã đăng nhập).
  | 'home' | 'users' | 'userPlus' | 'user' | 'card' | 'calendar' | 'clock' | 'cart' | 'bag' | 'returnArrow' | 'coin'
  | 'box' | 'receipt' | 'truck' | 'clipboard' | 'shield' | 'megaphone' | 'dumbbell' | 'star' | 'layers' | 'tag'
  | 'chart' | 'activity' | 'chevronDown' | 'menu';

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
  home: ['M3 11l9-8 9 8', 'M5 10v10h14V10', 'M10 20v-6h4v6'],                      // ngôi nhà
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M13 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0z', 'M22 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'], // hai người
  userPlus: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M13 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0z', 'M19 8v6', 'M22 11h-6'], // người + dấu cộng
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M16 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0z'], // một người
  card: ['M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z', 'M2 10h20', 'M6 15h4'], // thẻ thanh toán
  calendar: ['M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M16 2v4', 'M8 2v4', 'M3 10h18'], // lịch
  clock: ['M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z', 'M12 7v5l3 2'],                  // đồng hồ
  cart: ['M3 3h2l2.4 12.2a2 2 0 0 0 2 1.8h8.2a2 2 0 0 0 2-1.6L21 8H6', 'M10 21a1 1 0 1 1-2 0a1 1 0 1 1 2 0z', 'M19 21a1 1 0 1 1-2 0a1 1 0 1 1 2 0z'], // xe đẩy
  bag: ['M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z', 'M3 6h18', 'M16 10a4 4 0 0 1-8 0'], // túi mua hàng
  returnArrow: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],               // mũi tên quay ngược (hàng trả)
  coin: ['M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z', 'M15 9a3 2 0 0 0-3-1c-1.7 0-3 .9-3 2s1.3 2 3 2 3 .9 3 2-1.3 2-3 2a3 2 0 0 1-3-1', 'M12 6v2', 'M12 16v2'], // đồng xu (hoàn tiền)
  box: ['M21 8l-9-5-9 5v8l9 5 9-5z', 'M3 8l9 5 9-5', 'M12 13v8'],                  // thùng hàng (tồn kho)
  receipt: ['M6 2h12v20l-3-2-3 2-3-2-3 2z', 'M9 7h6', 'M9 11h6', 'M9 15h4'],        // phiếu
  truck: ['M2 4h13v12H2z', 'M15 9h4l3 3v4h-7', 'M8 18a2 2 0 1 1-4 0a2 2 0 1 1 4 0z', 'M20 18a2 2 0 1 1-4 0a2 2 0 1 1 4 0z'], // xe tải (xuất kho)
  clipboard: ['M9 3h6v4H9z', 'M9 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3', 'M9 14l2 2 4-4'], // bảng kiểm kê
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],                          // khiên (tài khoản, phân quyền)
  megaphone: ['M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1z', 'M17 9a4 4 0 0 1 0 6', 'M20 6a8 8 0 0 1 0 12'], // loa (thông báo nhóm)
  dumbbell: ['M6 7v10', 'M3 9v6', 'M18 7v10', 'M21 9v6', 'M6 12h12'],               // tạ tay
  star: ['M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z'], // ngôi sao (đánh giá)
  layers: ['M12 2l10 5-10 5L2 7z', 'M2 12l10 5 10-5', 'M2 17l10 5 10-5'],          // các lớp (danh mục)
  tag: ['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z', 'M8 7a1 1 0 1 1-2 0a1 1 0 1 1 2 0z'], // nhãn giá (sản phẩm)
  chart: ['M3 3v18h18', 'M7 15l4-4 3 3 5-6'],                                      // biểu đồ (báo cáo)
  activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],                                         // nhịp (đối chiếu hoạt động)
  chevronDown: ['M6 9l6 6 6-6'],                                                   // mũi tên xuống (mở/đóng nhóm)
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],                                       // ba gạch (mở menu trên điện thoại)
};

// Chỉ vẽ hình, không kèm chữ: dùng khi chữ đã nằm ngay cạnh (mục menu), tránh trình đọc màn hình đọc tên hai lần.
export function IconSvg({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {iconPaths[name].map(d => <path key={d} d={d} />)}
  </svg>;
}

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
