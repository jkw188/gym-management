// Cấu hình NestJS (US-09 bước 1–2): module hồ sơ hội viên, khai báo controller /api/members và service nghiệp vụ.
// Dữ liệu members lấy từ MembersDataModule; tra account để liên kết qua UsersService (UsersModule).
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { OperationsModule } from '../operations/operations.module';
import { UsersModule } from '../users/users.module';
import { MemberSchema } from './schemas/member.schema';
import { MemberLinkEventSchema } from './schemas/member-link-event.schema';
import { MembersRepository } from './members.repository';
import { MembersService } from './members.service';
import { MembersController } from './members.controller';
import { MembersQueryRepository } from './members-query.repository';
import { MembersQueryService } from './members-query.service';
import { ServerClock } from '../../common/utils/business-date';

@Module({
  imports: [MongooseModule.forFeature([{ name: 'Member', schema: MemberSchema },
    { name: 'MemberLinkEvent', schema: MemberLinkEventSchema }]), UsersModule, OperationsModule, TransactionModule],
  controllers: [MembersController], providers: [MembersRepository, MembersService, MembersQueryRepository, MembersQueryService, ServerClock],
  exports: [MembersRepository],
})
export class MembersModule {}
