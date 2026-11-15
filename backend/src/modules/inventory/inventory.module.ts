import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { StockMovementSchema } from '../stock/stock.schema';
import { InventoryWriter } from './inventory-writer';
import { ProductOptionsController } from './product-options.controller';
import { ProductOptionsService } from './product-options.service';
import { InventoryController, StockMovementsController } from './inventory.controller';
import { InventoryQueryService } from './inventory-query.service';

@Module({ imports: [TransactionModule, MongooseModule.forFeature([{ name: 'StockMovement', schema: StockMovementSchema }])],
  controllers: [ProductOptionsController, InventoryController, StockMovementsController], providers: [InventoryWriter, ProductOptionsService, InventoryQueryService], exports: [InventoryWriter] })
export class InventoryModule {}
