// Cấu hình NestJS (US-09 bước 1): module hồ sơ hội viên, khai báo model members, controller /api/members,
// service nghiệp vụ và repository.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OperationsModule } from '../operations/operations.module';
import { MembersController } from './members.controller';
import { MembersRepository } from './members.repository';
import { MembersService } from './members.service';
import { MemberSchema } from './schemas/member.schema';

@Module({
  imports: [
    // OperationsModule cung cấp IdempotencyService (EN-02) để chống tạo lặp theo Idempotency-Key.
    OperationsModule,
    MongooseModule.forFeature([{ name: 'Member', schema: MemberSchema }]),
  ],
  controllers: [MembersController],
  providers: [MembersService, MembersRepository],
})
export class MembersModule {}
