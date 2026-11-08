// Cấu hình NestJS (US-09 bước 1–2): module hồ sơ hội viên, khai báo controller /api/members và service nghiệp vụ.
// Dữ liệu members lấy từ MembersDataModule; tra account để liên kết qua UsersService (UsersModule).
import { Module } from '@nestjs/common';
import { OperationsModule } from '../operations/operations.module';
import { UsersModule } from '../users/users.module';
import { MembersDataModule } from './members-data.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  imports: [
    // OperationsModule cung cấp IdempotencyService (EN-02) để chống tạo lặp theo Idempotency-Key.
    OperationsModule,
    MembersDataModule,
    // US-09 bước 2: UsersService tra account MEMBER theo đúng số phone.
    UsersModule,
  ],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
