// Kiểu dữ liệu dùng chung (EN-03 bước 1): đầu vào/đầu ra của persistBusinessEvent mà các module nghiệp vụ gọi nội bộ.

// Nguồn sự kiện do module nghiệp vụ (vd hoàn tất sale) truyền vào; các id là chuỗi ObjectId.
export interface BusinessEventSource {
  eventKey: string;
  title: string;
  body: string;
  memberId?: string;
  transactionId?: string;
  createdBy?: string;
}

// EN-03-F03: response sale chỉ báo đã lưu hay không có account nhận, không báo người dùng đã xem.
export type NotificationState = 'STORED' | 'NO_LINKED_ACCOUNT';

export interface PersistedEvent {
  notificationId: string;
  notificationState: NotificationState;
}

// Dữ liệu một thông báo gửi cho client (socket notification.created và REST sync ở bước 3).
export interface NotificationItem {
  id: string;
  eventKey: string;
  title: string;
  body: string;
  sequence: string;
  createdAt: string;
}
