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
import { AuthSessionSchema } from '../auth/schemas/auth-session.schema';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { SecurityStateSchema } from './schemas/security-state.schema';
import { SecurityEventSchema } from './schemas/security-event.schema';
import { AccountSecurityService } from './account-security.service';
import { PermissionSchema, RolePermissionSchema } from './schemas/permission.schema';
import { AccessCatalogService } from './access-catalog.service';
import { AccessController } from './access.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: 'Account', schema: AccountSchema }, { name: 'Role', schema: RoleSchema },
    { name: 'MemberRegistration', schema: MemberRegistrationSchema }, { name: 'AuthSession', schema: AuthSessionSchema },
    { name: 'SecurityState', schema: SecurityStateSchema }, { name: 'SecurityEvent', schema: SecurityEventSchema },
    { name: 'Permission', schema: PermissionSchema }, { name: 'RolePermission', schema: RolePermissionSchema }]), TransactionModule],
  controllers: [UsersController, AccessController],
  providers: [UsersRepository, UsersService, PasswordService, SeedAdminService, MemberRegistrationReader, AccountSecurityService, AccessCatalogService],
  exports: [UsersService, UsersRepository, PasswordService, SeedAdminService, AccountSecurityService],
})
export class UsersModule {}
