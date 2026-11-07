import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PasswordService } from '../../common/security/password.service';
import { AccountSchema } from './schemas/account.schema';
import { RoleSchema } from './schemas/role.schema';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';
import { SeedAdminService } from './seed-admin.service';
import { UsersController } from './users.controller';
import { MemberRegistrationReader, MemberRegistrationSchema } from '../members/member-registration.reader';

@Module({
  imports: [MongooseModule.forFeature([{ name: 'Account', schema: AccountSchema }, { name: 'Role', schema: RoleSchema },
    { name: 'MemberRegistration', schema: MemberRegistrationSchema }])],
  controllers: [UsersController],
  providers: [UsersRepository, UsersService, PasswordService, SeedAdminService, MemberRegistrationReader],
  exports: [UsersService, UsersRepository, PasswordService, SeedAdminService],
})
export class UsersModule {}
