// Tầng giao diện – hàm dùng chung: định dạng thời gian của thông báo theo giờ Việt Nam, dạng "14:30 20/11/2026".
// Dùng cho chuông (dropdown) và hộp thư; chỉ đổi cách hiển thị, không liên quan nghiệp vụ.
export function formatNotificationTime(iso: string) {
  return new Date(iso).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}
