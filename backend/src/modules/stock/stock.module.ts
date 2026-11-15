import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ServerClock } from '../../common/utils/business-date';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OperationsModule } from '../operations/operations.module';
import { StockReceiptsController } from './stock-receipts.controller';
import { StockReceiptsService } from './stock-receipts.service';
import { StockRepository } from './stock.repository';
import { STOCK_MODELS } from './stock.schema';

@Module({ imports: [TransactionModule, OperationsModule, InventoryModule, MongooseModule.forFeature(STOCK_MODELS)],
  controllers: [StockReceiptsController], providers: [StockRepository, StockReceiptsService, ServerClock] })
export class StockModule {}
