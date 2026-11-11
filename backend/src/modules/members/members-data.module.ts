// Cấu hình NestJS (US-09 bước 2–3): module dữ liệu hồ sơ hội viên, gồm model members, member_link_events, MembersRepository và
// MemberRegistrationReader. Tách riêng để UsersModule (US-01) và MembersModule cùng dùng mà không import vòng.
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MemberRegistrationReader } from './member-registration.reader';
import { MembersRepository } from './members.repository';
import { MemberLinkEventSchema } from './schemas/member-link-event.schema';
import { MemberSchema } from './schemas/member.schema';

@Module({
  imports: [MongooseModule.forFeature([
    { name: 'Member', schema: MemberSchema },
    // US-09 bước 3: audit liên kết hồ sơ – account.
    { name: 'MemberLinkEvent', schema: MemberLinkEventSchema },
  ])],
  providers: [MembersRepository, MemberRegistrationReader],
  // MembersRepository chỉ dành cho MembersModule; module khác (UsersModule) chỉ được dùng MemberRegistrationReader.
  exports: [MembersRepository, MemberRegistrationReader],
})
export class MembersDataModule {}
