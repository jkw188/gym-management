import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PasswordService } from '../../common/security/password.service';
import { AccountSchema } from './schemas/account.schema';
import { RoleSchema } from './schemas/role.schema';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';
import { SeedAdminService } from './seed-admin.service';
import { UsersController } from './users.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: 'Account', schema: AccountSchema }, { name: 'Role', schema: RoleSchema }])],
  controllers: [UsersController],
  providers: [UsersRepository, UsersService, PasswordService, SeedAdminService],
  exports: [UsersService, UsersRepository, PasswordService, SeedAdminService],
})
export class UsersModule {}
