// Cấu hình NestJS (EN-03 bước 1–3, US-47): module thông báo, outbox worker, gateway socket, REST sync và inbox member.
// Module nghiệp vụ khác import để gọi NotificationsService.persistBusinessEvent.
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { OperationsModule } from '../operations/operations.module';
import { NotificationBroadcastSchema } from './schemas/notification-broadcast.schema';
import { NotificationBroadcastController } from './notification-broadcast.controller';
import { NotificationBroadcastService } from './notification-broadcast.service';
import { NotificationBroadcastRepository } from './notification-broadcast.repository';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { NotificationDispatcher } from './notification-dispatcher';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationOutboxService } from './notification-outbox.service';
import { NotificationInboxController } from './notification-inbox.controller';
import { NotificationsController } from './notifications.controller';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { NotificationCounterSchema } from './schemas/notification-counter.schema';
import { NotificationOutboxSchema } from './schemas/notification-outbox.schema';
import { NotificationRecipientSchema } from './schemas/notification-recipient.schema';
import { NotificationSchema } from './schemas/notification.schema';

@Module({
  imports: [
    // AuthModule cung cấp AuthService để socket kiểm token/phiên giống HTTP (AUTH-F06).
    AuthModule, TransactionModule, OperationsModule,
    MongooseModule.forFeature([
      { name: 'NotificationBroadcast', schema: NotificationBroadcastSchema },
      { name: 'Notification', schema: NotificationSchema },
      { name: 'NotificationRecipient', schema: NotificationRecipientSchema },
      { name: 'NotificationOutbox', schema: NotificationOutboxSchema },
      { name: 'NotificationCounter', schema: NotificationCounterSchema },
    ]),
  ],
  controllers: [NotificationBroadcastController, NotificationsController, NotificationInboxController],
  providers: [NotificationBroadcastService, NotificationBroadcastRepository, NotificationsService, NotificationInboxService, NotificationsRepository, NotificationOutboxService, NotificationDispatcher, NotificationsGateway],
  exports: [NotificationsService],
})
export class NotificationsModule {}
