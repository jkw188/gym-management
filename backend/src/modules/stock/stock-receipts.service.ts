import { Injectable } from '@nestjs/common';
import { StockDocumentsService } from './stock-documents.service';

@Injectable()
export class StockReceiptsService extends StockDocumentsService {
  protected readonly kind = 'RECEIPT' as const;
}
