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
import { RetailProduct } from '../catalog/retail-catalog.schema';
import { InventoryWriter, inventoryIntegrityError, LockedBalance, STOCK_MAX, validBalance } from '../inventory/inventory-writer';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { CreateAdjustmentDto, UpdateAdjustmentDto } from './stock-adjustments.dto';
import { stockDocumentHeader } from './stock-documents.service';
import { PostReceiptDto, ReceiptQueryDto } from './stock-receipts.dto';
import { literalStockQuery, StockRepository } from './stock.repository';
import { StockDocument, StockDocumentItem } from './stock.schema';

const idOf = (id: string) => new Types.ObjectId(validateObjectId(id));
const missing = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy phiếu điều chỉnh');
const conflict = () => new ApplicationError(409, 'VERSION_CONFLICT', 'Phiếu đã thay đổi. Hãy tải lại để đối chiếu');
const uint = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= STOCK_MAX;
const CostDecimal = Decimal.clone({ precision: 30 });
function stale() { return new ApplicationError(409, 'COUNT_SNAPSHOT_STALE', 'Kho đã có biến động sau mốc kiểm kê. Hãy xem biến động, kiểm đếm lại thực tế và nhập số đếm mới'); }

@Injectable()
export class StockAdjustmentsService {
  constructor(private readonly repository: StockRepository, private readonly transactions: TransactionRunner,
    private readonly guards: DataGuardsService, private readonly idempotency: IdempotencyService,
    private readonly writer: InventoryWriter, private readonly clock: ServerClock) {}

  async list(query: ReceiptQueryDto) {
    const to = assertBusinessDate(query.toDate ?? this.clock.today());
    const from = assertBusinessDate(query.fromDate ?? addCalendarDays(to, -29));
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (days < 1 || days > 366) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Khoảng ngày phải từ 1 đến 366 ngày');
    const filter: Filter<StockDocument> = { kind: 'ADJUSTMENT', created_at: { $gte: new Date(`${from}T00:00:00+07:00`), $lt: new Date(`${addCalendarDays(to, 1)}T00:00:00+07:00`) } };
    if (query.status) filter.status = query.status;
    if (query.q) filter.$or = [{ code: literalStockQuery(query.q) }, { source_reference: literalStockQuery(query.q) }];
    return this.transactions.run(async session => {
      const page = await this.repository.page(filter, query.page, query.limit, session);
      return { ...page, items: page.items.map(stockDocumentHeader) };
    });
  }
  async detail(id: string) {
    const target = idOf(id);
    return this.transactions.run(async session => {
      const row = await this.repository.document(target, session, 'ADJUSTMENT'); if (!row) throw missing();
      const body = await this.mapDetail(row, session);
      const events = await this.repository.events.find({ document_id: target }).sort({ occurred_at: 1, _id: 1 }).session(session).lean().exec();
      return { ...body, audit: events.map(event => ({ id: String(event._id), action: event.action, actorId: String(event.actor_id), occurredAt: event.occurred_at.toISOString(), before: event.before, after: event.after })) };
    });
  }
  private async mapDetail(row: StockDocument, session: ClientSession) {
    const items = [];
    for (const line of await this.repository.lines(row._id, session)) {
      const product = await this.repository.product(String(line.product_id), session);
      const category = product ? await this.repository.category(product.category_id, session) : null;
      const balance = await this.repository.connection.db!.collection<LockedBalance>('inventory').findOne({ product_id: line.product_id }, { session });
      const valid = validBalance(balance);
      items.push({ id: String(line._id), productId: String(line.product_id), skuSnapshot: line.sku_snapshot, nameSnapshot: line.name_snapshot,
        countedQuantity: line.counted_quantity!, baseOnHand: line.base_on_hand!, baseInventoryVersion: line.base_inventory_version!, countedAt: line.counted_at!.toISOString(),
        quantityDelta: line.quantity_delta, unitCost: fromVndDecimal(line.unit_cost), lineTotalCost: fromVndDecimal(line.line_total_cost),
        currentOnHand: valid ? balance!.on_hand : null, currentReserved: valid ? balance!.reserved : null, currentInventoryVersion: valid ? balance!.version : null,
        inventoryState: !balance ? 'MISSING' : valid ? 'VALID' : 'INCONSISTENT',
        // POSTED is an immutable historical count, not a draft requiring rebase after its own movement.
        stale: row.status === 'DRAFT' && (!valid || balance!.version !== line.base_inventory_version || balance!.on_hand !== line.base_on_hand),
        inactiveWarning: !product || product.status !== 'ACTIVE' || category?.status !== 'ACTIVE' });
    }
    const movements = (await this.repository.documentMovements(row._id, session, 'ADJUSTMENT_POST')).map(movement => ({ id: String(movement._id),
      documentItemId: String(movement.document_item_id), productId: String(movement.product_id), sequence: movement.sequence,
      skuSnapshot: movement.sku_snapshot, nameSnapshot: movement.name_snapshot, onHandDelta: movement.on_hand_delta, reservedDelta: movement.reserved_delta,
      beforeOnHand: movement.before_on_hand, beforeReserved: movement.before_reserved, afterOnHand: movement.after_on_hand, afterReserved: movement.after_reserved,
      createdAt: movement.created_at.toISOString(), sourceId: String(row._id), sourceCode: row.code }));
    return { ...stockDocumentHeader(row), items, stale: items.some(item => item.stale), movements, movementIds: movements.map(item => item.id) };
  }
  async save(actorId: string, input: CreateAdjustmentDto | UpdateAdjustmentDto, key: string, id?: string) {
    const target = id ? idOf(id) : undefined, payload = this.normalize(input);
    const operation = target ? 'STOCK_ADJUST_UPDATE' : 'STOCK_ADJUST_CREATE';
    await this.repository.assertWriterReady();
    return this.idempotency.execute({ actorId, operation, clientKey: key, payload, targetId: target?.toHexString() }, async session => {
      await this.guards.acquire(session, { catalog: true });
      const old = target ? await this.repository.document(target, session, 'ADJUSTMENT') : null;
      if (target && !old) throw missing();
      if (old?.status === 'POSTED') throw new ApplicationError(409, 'DOCUMENT_NOT_EDITABLE', 'Phiếu đã ghi sổ không thể sửa');
      if (old && (old.version !== (input as UpdateAdjustmentDto).version || old.version >= STOCK_MAX)) throw conflict();
      const previous = old ? await this.repository.lines(old._id, session) : [];
      // Missing product is a 404; an existing product without valid inventory is an integrity conflict.
      const products = new Map<string, RetailProduct>();
      for (const item of payload.items) {
        const product = await this.repository.product(item.productId, session);
        if (!product) throw new ApplicationError(404, 'PRODUCT_NOT_FOUND', 'Sản phẩm không tồn tại');
        if (!await this.repository.category(product.category_id, session)) throw inventoryIntegrityError();
        products.set(item.productId, product);
      }
      const balances = await this.writer.lock([...previous.map(line => String(line.product_id)), ...payload.items.map(line => line.productId)], session, true);
      const now = this.clock.now(), actor = idOf(actorId), documentId = old?._id ?? new Types.ObjectId();
      const lines: Omit<StockDocumentItem, '_id' | 'id'>[] = [];
      let total = '0';
      for (const item of payload.items) {
        const balance = balances.get(item.productId)!;
        if (balance.version !== item.expectedInventoryVersion) throw stale();
        const product = products.get(item.productId)!;
        const delta = item.countedQuantity - balance.on_hand;
        const cost = normalizeVnd(new CostDecimal(item.unitCost).times(Math.abs(delta)).toFixed(0)); total = addVnd(total, cost);
        lines.push({ document_id: documentId, product_id: product._id, counted_quantity: item.countedQuantity, base_on_hand: balance.on_hand,
          base_inventory_version: balance.version, counted_at: now, quantity_delta: delta, unit_cost: toVndDecimal(item.unitCost),
          line_total_cost: toVndDecimal(cost), sku_snapshot: product.sku, name_snapshot: product.name });
      }
      const before = old ? await this.mapDetail(old, session) : null;
      const data = { reason: payload.reason, source_reference: payload.sourceReference, total_cost: toVndDecimal(total), updated_by: actor, updated_at: now };
      let row: StockDocument;
      if (old) {
        const updated = await this.repository.documents.findOneAndUpdate({ _id: old._id, kind: 'ADJUSTMENT', status: 'DRAFT', version: old.version },
          { $set: data, $inc: { version: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean().exec();
        if (!updated) throw conflict(); row = updated;
      } else {
        const [created] = await this.repository.documents.create([{ ...data, _id: documentId, code: `ADJ-${documentId.toHexString()}`,
          kind: 'ADJUSTMENT', status: 'DRAFT', version: 0, created_by: actor, created_at: now }], { session }); row = created.toObject();
      }
      await this.repository.replaceItems(documentId, lines, session);
      const body = await this.mapDetail(row, session);
      await this.repository.insertEvent({ document_id: documentId, actor_id: actor, action: old ? 'UPDATED' : 'CREATED', before, after: body,
        occurred_at: now, request_key: transactionRequestKey(actorId, operation, key) }, session);
      return { status: old ? 200 : 201, body, resultIds: { documentId } };
    });
  }
  async post(actorId: string, id: string, input: PostReceiptDto, key: string) {
    const target = idOf(id), operation = 'STOCK_ADJUST_POST' as const;
    await this.repository.assertWriterReady();
    try {
      return await this.idempotency.execute({ actorId, operation, clientKey: key, payload: { version: input.version }, targetId: target.toHexString() }, async session => {
        await this.guards.acquire(session, { catalog: true });
        const old = await this.repository.document(target, session, 'ADJUSTMENT'); if (!old) throw missing();
        if (old.status === 'POSTED') return { status: 200, body: await this.postedResult(old, session), resultIds: { documentId: target } };
        if (old.version !== input.version || old.version >= STOCK_MAX) throw conflict();
        const lines = await this.repository.lines(target, session);
        if (lines.length < 1 || lines.length > 100 || new Set(lines.map(line => String(line.product_id))).size !== lines.length) throw inventoryIntegrityError();
        const balances = await this.writer.lock(lines.map(line => String(line.product_id)), session, true);
        let total = '0';
        for (const line of lines) {
          if (![line.counted_quantity, line.base_on_hand, line.base_inventory_version].every(uint) ||
            !(line.counted_at instanceof Date) || !Number.isFinite(line.counted_at.getTime()) || line.quantity_delta !== line.counted_quantity! - line.base_on_hand!) throw inventoryIntegrityError();
          const balance = balances.get(String(line.product_id))!;
          if (balance.version !== line.base_inventory_version || balance.on_hand !== line.base_on_hand) throw stale();
          if (line.counted_quantity! < balance.reserved) throw new ApplicationError(409, 'COUNT_BELOW_RESERVED', 'Số đếm thấp hơn hàng đang giữ. Xử lý đơn qua luồng nguồn rồi kiểm đếm lại');
          if (line.quantity_delta !== 0) this.writer.check(balance, line.quantity_delta, 0);
          try {
            const cost = normalizeVnd(new CostDecimal(fromVndDecimal(line.unit_cost)).times(Math.abs(line.quantity_delta)).toFixed(0));
            if (cost !== fromVndDecimal(line.line_total_cost)) throw inventoryIntegrityError(); total = addVnd(total, cost);
          } catch { throw inventoryIntegrityError(); }
        }
        try { if (total !== fromVndDecimal(old.total_cost)) throw inventoryIntegrityError(); }
        catch { throw inventoryIntegrityError(); }
        const before = await this.mapDetail(old, session), now = this.clock.now(), actor = idOf(actorId);
        const row = await this.repository.documents.findOneAndUpdate({ _id: target, kind: 'ADJUSTMENT', status: 'DRAFT', version: input.version }, {
          $set: { status: 'POSTED', posted_at: now, posted_by: actor, updated_at: now, updated_by: actor }, $inc: { version: 1 },
        }, { session, returnDocument: 'after', runValidators: true }).lean().exec();
        if (!row) throw conflict();
        // Snapshots and item ids survive posting. A zero delta is a count record, without a ledger movement.
        for (const line of lines) if (line.quantity_delta !== 0) {
          await this.writer.apply(balances.get(String(line.product_id))!, { product_id: line.product_id, document_item_id: line._id,
            event_key: `ADJUSTMENT_POST:${line._id}`, kind: 'ADJUSTMENT_POST', source_id: target, source_type: 'STOCK_ADJUST', source_code: old.code, actor_id: actor,
            on_hand_delta: line.quantity_delta, reserved_delta: 0, sku_snapshot: line.sku_snapshot, name_snapshot: line.name_snapshot, created_at: now }, session);
        }
        const body = await this.postedResult(row, session);
        await this.repository.insertEvent({ document_id: target, actor_id: actor, action: 'POSTED', before, after: await this.mapDetail(row, session),
          occurred_at: now, request_key: transactionRequestKey(actorId, operation, key) }, session);
        return { status: 200, body, resultIds: { documentId: target } };
      });
    } catch (error) { if (isDuplicateKey(error)) throw inventoryIntegrityError(); throw error; }
  }
  private async postedResult(row: StockDocument, session: ClientSession) {
    return { id: String(row._id), code: row.code, status: 'POSTED', version: row.version, postedAt: row.posted_at!.toISOString(), postedBy: String(row.posted_by),
      totalCost: fromVndDecimal(row.total_cost), movementIds: await this.repository.movementIds(row._id, session, 'ADJUSTMENT_POST') };
  }
  private normalize(input: CreateAdjustmentDto | UpdateAdjustmentDto) {
    if (typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.trim().length > 500 ||
      input.sourceReference !== undefined && (typeof input.sourceReference !== 'string' || input.sourceReference.trim().length > 100) ||
      !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw new ApplicationError(400, 'VALIDATION_ERROR', 'Phiếu kiểm kê không hợp lệ');
    const seen = new Set<string>();
    const items = input.items.map(line => {
      const productId = idOf(line.productId).toHexString();
      if (seen.has(productId) || !uint(line.countedQuantity) || !uint(line.expectedInventoryVersion)) throw new ApplicationError(400, 'VALIDATION_ERROR', 'SKU không trùng; số đếm và phiên bản kho phải là số nguyên Int32 không âm');
      seen.add(productId); return { productId, countedQuantity: line.countedQuantity, expectedInventoryVersion: line.expectedInventoryVersion, unitCost: normalizeVnd(line.unitCost) };
    });
    return { ...('version' in input ? { version: input.version } : {}), reason: input.reason.trim(), sourceReference: input.sourceReference?.trim() || '', items };
  }
}
