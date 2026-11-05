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

// Nội dung sự kiện socket notification.created (spec mục 3): chỉ các field này, không có member/transaction/recipient.
export interface NotificationCreatedPayload {
  id: string;
  eventKey: string;
  title: string;
  body: string;
  createdAt: string;
}

// Worker giao cho dispatcher: thông báo và danh sách account nhận đã chốt lúc commit.
export interface DispatchMessage {
  notification: NotificationCreatedPayload;
  recipientAccountIds: string[];
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
