// Cấu hình NestJS (US-09 bước 1): module hồ sơ hội viên, khai báo model members, controller /api/members,
// service nghiệp vụ, repository và hàm đọc theo phone cho US-01.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OperationsModule } from '../operations/operations.module';
import { MemberRegistrationReader } from './member-registration.reader';
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
  providers: [MembersService, MembersRepository, MemberRegistrationReader],
  // UsersModule (US-01 đăng ký) chỉ được dùng hàm đọc theo phone, không được dùng repository để ghi.
  exports: [MemberRegistrationReader],
})
export class MembersModule {}
