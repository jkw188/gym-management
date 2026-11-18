import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReminderOccurrenceSchema } from './reminder-occurrence.schema';
import { RemindersRepository } from './reminders.repository';
import { RemindersService } from './reminders.service';
import { RemindersWorker } from './reminders.worker';

@Module({ imports: [TransactionModule, NotificationsModule,
  MongooseModule.forFeature([{ name: 'ReminderOccurrence', schema: ReminderOccurrenceSchema }])],
  providers: [RemindersRepository, RemindersService, RemindersWorker] })
export class RemindersModule {}
