// Kiểu dữ liệu (EN-03 bước 3): thông báo nhận từ socket notification.created hoặc REST sync.

// Thông báo nhận qua socket chưa có sequence; nhận qua REST sync thì có sequence dạng chuỗi số.
export interface NotificationItem {
  id: string;
  eventKey: string;
  title: string;
  body: string;
  createdAt: string;
  sequence?: string;
}

export interface SyncResponse {
  items: NotificationItem[];
  nextCursor: string | null;
  hasMore: boolean;
}
