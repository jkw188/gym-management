import { Injectable } from '@nestjs/common';
import { ClientSession, Filter } from 'mongodb';
import { Types } from 'mongoose';
import Decimal from 'decimal.js';
import { ApplicationError } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { addCalendarDays, assertBusinessDate, ServerClock } from '../../common/utils/business-date';
import { validateObjectId } from '../../common/utils/normalization';
import { addVnd, fromVndDecimal, normalizeVnd, toVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { InventoryWriter, inventoryIntegrityError, STOCK_MAX } from '../inventory/inventory-writer';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { CreateReceiptDto, PostReceiptDto, ReceiptItemDto, ReceiptQueryDto, UpdateReceiptDto } from './stock-receipts.dto';
import { literalStockQuery, StockRepository } from './stock.repository';
import { StockDocument, StockDocumentItem } from './stock.schema';

const idOf = (id: string) => new Types.ObjectId(validateObjectId(id));
const missing = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy phiếu nhập');
const conflict = () => new ApplicationError(409, 'VERSION_CONFLICT', 'Phiếu đã thay đổi. Hãy tải lại trước khi tiếp tục');
function header(row: StockDocument) {
  return { id: String(row._id), code: row.code, status: row.status, version: row.version, reason: row.reason,
    sourceReference: row.source_reference ?? null, totalCost: fromVndDecimal(row.total_cost), createdBy: String(row.created_by), updatedBy: String(row.updated_by),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), postedAt: row.posted_at?.toISOString() ?? null, postedBy: row.posted_by ? String(row.posted_by) : null };
}
@Injectable()
export class StockReceiptsService {
  constructor(private readonly repository: StockRepository, private readonly transactions: TransactionRunner,
    private readonly guards: DataGuardsService, private readonly idempotency: IdempotencyService,
    private readonly writer: InventoryWriter, private readonly clock: ServerClock) {}

  async list(query: ReceiptQueryDto) {
    const to = assertBusinessDate(query.toDate ?? this.clock.today());
    const from = assertBusinessDate(query.fromDate ?? addCalendarDays(to, -29));
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 366) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Khoảng ngày phải từ 1 đến 366 ngày');
    const filter: Filter<StockDocument> = { kind: 'RECEIPT', created_at: { $gte: new Date(`${from}T00:00:00+07:00`), $lt: new Date(`${addCalendarDays(to, 1)}T00:00:00+07:00`) } };
    if (query.status) filter.status = query.status;
    if (query.q) filter.$or = [{ code: literalStockQuery(query.q) }, { source_reference: literalStockQuery(query.q) }];
    return this.transactions.run(async session => {
      const page = await this.repository.page(filter, query.page, query.limit, session);
      return { ...page, items: page.items.map(header) };
    });
  }
  async detail(id: string) {
    const target = idOf(id);
    return this.transactions.run(async session => {
      const row = await this.repository.document(target, session); if (!row) throw missing();
      return this.mapDetail(row, session);
    });
  }
  private async mapDetail(row: StockDocument, session: ClientSession) {
    const items = [];
    for (const line of await this.repository.lines(row._id, session)) {
      const product = await this.repository.product(String(line.product_id), session);
      const category = product ? await this.repository.category(product.category_id, session) : null;
      items.push({ id: String(line._id), productId: String(line.product_id), quantity: line.quantity_delta,
        skuSnapshot: line.sku_snapshot, nameSnapshot: line.name_snapshot, unitCost: fromVndDecimal(line.unit_cost), lineTotalCost: fromVndDecimal(line.line_total_cost),
        inactiveWarning: !product || product.status !== 'ACTIVE' || category?.status !== 'ACTIVE' });
    }
    const movements = (await this.repository.receiptMovements(row._id, session)).map(movement => ({ id: String(movement._id),
      documentItemId: String(movement.document_item_id), productId: String(movement.product_id), sequence: movement.sequence,
      skuSnapshot: movement.sku_snapshot, nameSnapshot: movement.name_snapshot, onHandDelta: movement.on_hand_delta, reservedDelta: movement.reserved_delta,
      beforeOnHand: movement.before_on_hand, beforeReserved: movement.before_reserved, afterOnHand: movement.after_on_hand, afterReserved: movement.after_reserved,
      createdAt: movement.created_at.toISOString(), sourceId: String(row._id), sourceCode: row.code }));
    return { ...header(row), items, movementIds: movements.map(movement => movement.id), movements };
  }
  async save(actorId: string, input: CreateReceiptDto | UpdateReceiptDto, key: string, id?: string) {
    const target = id ? idOf(id) : undefined;
    const payload = this.normalize(input);
    const operation = target ? 'STOCK_RECEIPT_UPDATE' : 'STOCK_RECEIPT_CREATE';
    await this.repository.assertWriterReady();
    return this.idempotency.execute({ actorId, operation, clientKey: key, payload, targetId: target?.toHexString() }, async session => {
      await this.guards.acquire(session, { catalog: true });
      const old = target ? await this.repository.document(target, session) : null;
      if (target && !old) throw missing();
      if (old?.status === 'POSTED') throw new ApplicationError(409, 'DOCUMENT_NOT_EDITABLE', 'Phiếu đã ghi sổ không thể sửa');
      if (old && (old.version !== (input as UpdateReceiptDto).version || old.version >= STOCK_MAX)) throw conflict();
      const documentId = old?._id ?? new Types.ObjectId(), actor = idOf(actorId), now = this.clock.now();
      const lines = await this.makeLines(documentId, payload.items, session);
      // The catalog lock precedes inventory locks; the document CAS always follows them.
      if (old) {
        const previous = await this.repository.lines(old._id, session);
        await this.writer.lock([...previous.map(line => String(line.product_id)), ...payload.items.map(line => line.productId)], session);
      }
      const before = old ? await this.mapDetail(old, session) : null;
      const total = lines.reduce((sum, line) => addVnd(sum, fromVndDecimal(line.line_total_cost)), '0');
      const data = { reason: payload.reason, source_reference: payload.sourceReference, total_cost: toVndDecimal(total), updated_by: actor, updated_at: now };
      let row: StockDocument;
      if (old) {
        const updated = await this.repository.documents.findOneAndUpdate({ _id: old._id, kind: 'RECEIPT', status: 'DRAFT', version: old.version },
          { $set: data, $inc: { version: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean().exec();
        if (!updated) throw conflict(); row = updated;
      } else {
        const [created] = await this.repository.documents.create([{ ...data, _id: documentId, code: `RCV-${documentId.toHexString()}`,
          kind: 'RECEIPT', status: 'DRAFT', version: 0, created_by: actor, created_at: now }], { session }); row = created.toObject();
      }
      await this.repository.replaceItems(documentId, lines, session);
      const body = await this.mapDetail(row, session);
      await this.repository.insertEvent({ document_id: documentId, actor_id: actor, action: old ? 'UPDATED' : 'CREATED', before, after: body,
        occurred_at: now, request_key: transactionRequestKey(actorId, operation, key.toLowerCase()) }, session);
      return { status: old ? 200 : 201, body, resultIds: { documentId } };
    });
  }
  async post(actorId: string, id: string, input: PostReceiptDto, key: string) {
    const target = idOf(id), operation = 'STOCK_RECEIPT_POST';
    await this.repository.assertWriterReady();
    try {
      return await this.idempotency.execute({ actorId, operation, clientKey: key, payload: { version: input.version }, targetId: target.toHexString() }, async session => {
        await this.guards.acquire(session, { catalog: true });
        const old = await this.repository.document(target, session); if (!old) throw missing();
        // A new key for POSTED ignores the former draft version, without another movement or audit.
        if (old.status === 'POSTED') return { status: 200, body: await this.postedResult(old, session), resultIds: { documentId: target } };
        const previous = await this.repository.lines(target, session);
        let payload: ReturnType<StockReceiptsService['normalize']>;
        try {
          payload = this.normalize({ reason: old.reason, sourceReference: old.source_reference, items: previous.map(line => ({
            productId: String(line.product_id), quantity: line.quantity_delta, unitCost: fromVndDecimal(line.unit_cost),
          })) });
        } catch { throw inventoryIntegrityError(); }
        const lines = await this.makeLines(target, payload.items, session);
        const balances = await this.writer.lock(payload.items.map(line => line.productId), session);
        for (const line of lines) this.writer.check(balances.get(String(line.product_id))!, line.quantity_delta, 0);
        if (old.version !== input.version || old.version >= STOCK_MAX) throw conflict();
        const before = await this.mapDetail(old, session), now = this.clock.now(), actor = idOf(actorId);
        const totalCost = lines.reduce((sum, line) => addVnd(sum, fromVndDecimal(line.line_total_cost)), '0');
        const row = await this.repository.documents.findOneAndUpdate({ _id: target, kind: 'RECEIPT', status: 'DRAFT', version: input.version }, {
          $set: { status: 'POSTED', posted_at: now, posted_by: actor, updated_at: now, updated_by: actor, total_cost: toVndDecimal(totalCost) }, $inc: { version: 1 },
        }, { session, returnDocument: 'after', runValidators: true }).lean().exec();
        if (!row) throw conflict();
        // Preserve item ids: movements and immutable snapshots refer to the same persisted draft lines.
        for (const line of lines) {
          const persisted = previous.find(item => String(item.product_id) === String(line.product_id))!;
          const refreshed = await this.repository.items.updateOne({ _id: persisted._id, document_id: target }, { $set: line }, { session, runValidators: true });
          if (refreshed.matchedCount !== 1) throw inventoryIntegrityError();
          await this.writer.apply(balances.get(String(line.product_id))!, { product_id: line.product_id, document_item_id: persisted._id,
            event_key: `RECEIPT_POST:${persisted._id}`, kind: 'RECEIPT_POST', source_id: target, source_type: 'STOCK_RECEIPT', source_code: old.code, actor_id: actor,
            on_hand_delta: line.quantity_delta, reserved_delta: 0, sku_snapshot: line.sku_snapshot, name_snapshot: line.name_snapshot, created_at: now }, session);
        }
        const body = await this.postedResult(row, session);
        await this.repository.insertEvent({ document_id: target, actor_id: actor, action: 'POSTED', before, after: await this.mapDetail(row, session),
          occurred_at: now, request_key: transactionRequestKey(actorId, operation, key.toLowerCase()) }, session);
        return { status: 200, body, resultIds: { documentId: target } };
      });
    } catch (error) { if (isDuplicateKey(error)) throw inventoryIntegrityError(); throw error; }
  }
  private async postedResult(row: StockDocument, session: ClientSession) {
    return { id: String(row._id), code: row.code, status: 'POSTED', version: row.version, postedAt: row.posted_at!.toISOString(),
      postedBy: String(row.posted_by), totalCost: fromVndDecimal(row.total_cost), movementIds: await this.repository.movementIds(row._id, session) };
  }
  private normalize(input: CreateReceiptDto | UpdateReceiptDto) {
    if (typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.trim().length > 500 ||
      input.sourceReference !== undefined && (typeof input.sourceReference !== 'string' || input.sourceReference.trim().length > 100) ||
      !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Phiếu nhập không hợp lệ');
    const seen = new Set<string>();
    const items = input.items.map(line => {
      const productId = idOf(line.productId).toHexString();
      if (seen.has(productId) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 1000000) {
        throw new ApplicationError(400, 'VALIDATION_ERROR', 'Mỗi sản phẩm chỉ một dòng, số lượng nguyên từ 1 đến 1000000');
      }
      seen.add(productId); return { productId, quantity: line.quantity, unitCost: normalizeVnd(line.unitCost) };
    });
    return { ...('version' in input ? { version: input.version } : {}), reason: input.reason.trim(), sourceReference: input.sourceReference?.trim() || '', items };
  }
  private async makeLines(documentId: Types.ObjectId, items: ReceiptItemDto[], session: ClientSession): Promise<Omit<StockDocumentItem, '_id' | 'id'>[]> {
    const lines = []; let total = '0';
    for (const item of items) {
      const product = await this.repository.product(item.productId, session);
      if (!product) throw new ApplicationError(404, 'PRODUCT_NOT_FOUND', 'Sản phẩm không tồn tại');
      if (!await this.repository.category(product.category_id, session)) throw new ApplicationError(409, 'PRODUCT_NOT_FOUND', 'Danh mục sản phẩm cần được đối chiếu');
      const lineTotal = normalizeVnd(new Decimal(item.unitCost).times(item.quantity).toFixed(0));
      total = addVnd(total, lineTotal);
      lines.push({ document_id: documentId, product_id: product._id, quantity_delta: item.quantity, unit_cost: toVndDecimal(item.unitCost),
        line_total_cost: toVndDecimal(lineTotal), sku_snapshot: product.sku, name_snapshot: product.name });
    }
    return lines;
  }
}
