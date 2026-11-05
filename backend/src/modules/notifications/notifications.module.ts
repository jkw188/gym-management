// Cấu hình NestJS (EN-03 bước 1): module thông báo; module nghiệp vụ import để gọi NotificationsService.persistBusinessEvent.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
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
  providers: [NotificationsService, NotificationsRepository],
  exports: [NotificationsService],
})
export class NotificationsModule {}
