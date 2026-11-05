// Cấu hình NestJS (EN-03 bước 1–2): module thông báo và outbox worker; module nghiệp vụ import để gọi NotificationsService.persistBusinessEvent.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationDispatcher } from './notification-dispatcher';
import { NotificationOutboxService } from './notification-outbox.service';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { NotificationCounterSchema } from './schemas/notification-counter.schema';
import { NotificationOutboxSchema } from './schemas/notification-outbox.schema';
import { NotificationRecipientSchema } from './schemas/notification-recipient.schema';
import { NotificationSchema } from './schemas/notification.schema';

@Module({
  imports: [MongooseModule.forFeature([
    { name: 'Notification', schema: NotificationSchema },
    { name: 'NotificationRecipient', schema: NotificationRecipientSchema },
    { name: 'NotificationOutbox', schema: NotificationOutboxSchema },
    { name: 'NotificationCounter', schema: NotificationCounterSchema },
  ])],
  // EN-03 bước 2: worker outbox và dispatcher (bước 3 gateway sẽ thay phần thân dispatcher).
  providers: [NotificationsService, NotificationsRepository, NotificationOutboxService, NotificationDispatcher],
  exports: [NotificationsService],
})
export class NotificationsModule {}
