import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { OperationsModule } from '../operations/operations.module';
import { TrainerSchema } from './schemas/trainer.schema';
import { TrainerEventSchema } from './schemas/trainer-event.schema';
import { TrainersController } from './trainers.controller';
import { TrainersRepository } from './trainers.repository';
import { TrainersService } from './trainers.service';

@Module({
  imports: [TransactionModule, OperationsModule, MongooseModule.forFeature([
    { name: 'Trainer', schema: TrainerSchema }, { name: 'TrainerEvent', schema: TrainerEventSchema },
  ])],
  controllers: [TrainersController], providers: [TrainersRepository, TrainersService],
})
export class TrainersModule {}
