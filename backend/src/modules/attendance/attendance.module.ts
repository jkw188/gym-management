import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { OperationsModule } from '../operations/operations.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { TrainersModule } from '../trainers/trainers.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceRepository } from './attendance.repository';
import { AttendanceSchema, AttendanceEventSchema } from './attendance.schema';
import { AttendanceService } from './attendance.service';

@Module({
  imports: [TransactionModule, OperationsModule, ShiftsModule, TrainersModule, MongooseModule.forFeature([
    { name: 'Attendance', schema: AttendanceSchema }, { name: 'AttendanceEvent', schema: AttendanceEventSchema },
  ])],
  controllers: [AttendanceController], providers: [AttendanceRepository, AttendanceService],
})
export class AttendanceModule {}
