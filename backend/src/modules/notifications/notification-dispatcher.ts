// Tầng phân phối (EN-03 bước 2–3): nhận một thông báo đã commit từ worker và giao cho gateway gửi tới socket người nhận.
// Ném lỗi nghĩa là lượt dispatch thất bại (worker hẹn retry); người nhận offline vẫn là thành công.
import { Injectable } from '@nestjs/common';
import { NotificationsGateway } from './notifications.gateway';
import { DispatchMessage } from './notifications.types';

@Injectable()
export class NotificationDispatcher {
  constructor(private readonly gateway: NotificationsGateway) {}

  // EN-03-TC07: không có socket nào nhận thì gateway không gửi gì, lượt dispatch vẫn thành công.
  async dispatch(message: DispatchMessage): Promise<void> {
    await this.gateway.sendToRecipients(message);
  }
}
