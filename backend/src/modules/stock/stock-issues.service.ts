import { Injectable } from '@nestjs/common';
import { StockDocumentsService } from './stock-documents.service';

@Injectable()
export class StockIssuesService extends StockDocumentsService {
  protected readonly kind = 'ISSUE' as const;
}
