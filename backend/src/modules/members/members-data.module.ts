// Cấu hình NestJS (US-09 bước 2): module dữ liệu hồ sơ hội viên, gồm model members, MembersRepository và
// MemberRegistrationReader. Tách riêng để UsersModule (US-01) và MembersModule cùng dùng mà không import vòng.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MemberRegistrationReader } from './member-registration.reader';
import { MembersRepository } from './members.repository';
import { MemberSchema } from './schemas/member.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: 'Member', schema: MemberSchema }])],
  providers: [MembersRepository, MemberRegistrationReader],
  // MembersRepository chỉ dành cho MembersModule; module khác (UsersModule) chỉ được dùng MemberRegistrationReader.
  exports: [MembersRepository, MemberRegistrationReader],
})
export class MembersDataModule {}
