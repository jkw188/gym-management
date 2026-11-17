import { StockDocumentEditor } from './StockDocumentEditor';
import type { Receipt } from './stock-receipts.api';
export { stockIssue } from './StockDocumentEditor';

export function ReceiptEditor(props: { initial?: Receipt; onClose: () => void; onChanged: () => void }) {
  return <StockDocumentEditor {...props} />;
}
