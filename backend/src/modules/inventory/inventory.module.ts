import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { StockMovementSchema } from '../stock/stock.schema';
import { InventoryWriter } from './inventory-writer';
import { ProductOptionsController } from './product-options.controller';
import { ProductOptionsService } from './product-options.service';

@Module({ imports: [TransactionModule, MongooseModule.forFeature([{ name: 'StockMovement', schema: StockMovementSchema }])],
  controllers: [ProductOptionsController], providers: [InventoryWriter, ProductOptionsService], exports: [InventoryWriter] })
export class InventoryModule {}
