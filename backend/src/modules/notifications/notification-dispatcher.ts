// Tầng phân phối (EN-03 bước 2): nhận một thông báo đã commit và gửi tới socket của người nhận.
// Bước 2 chưa có socket nên chưa làm gì; bước 3 gateway thay phần thân. Ném lỗi nghĩa là lượt dispatch thất bại.
import { Injectable } from '@nestjs/common';
import { DispatchMessage } from './notifications.types';

@Injectable()
export class NotificationDispatcher {
  // Người nhận offline (không có socket nào) vẫn tính là dispatch thành công (EN-03-TC07).
  async dispatch(_message: DispatchMessage): Promise<void> {
    return;
  }
}
