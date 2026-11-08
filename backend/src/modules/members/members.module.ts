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

@Module({
  imports: [MongooseModule.forFeature([{ name: 'Member', schema: MemberSchema },
    { name: 'MemberLinkEvent', schema: MemberLinkEventSchema }]), UsersModule, OperationsModule, TransactionModule],
  controllers: [MembersController], providers: [MembersRepository, MembersService],
  exports: [MembersRepository],
})
export class MembersModule {}
