import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { isDuplicateKey } from '../../common/http/http-error.filter';
import { validateObjectId } from '../../common/utils/normalization';
import { normalizeVnd, toVndDecimal } from '../../common/utils/vnd-money';
import { DataGuardsService } from '../../infrastructure/transaction/data-guards.service';
import { IdempotencyService, transactionRequestKey } from '../operations/idempotency.service';
import { CreateRetailCategoryDto, CreateRetailProductDto, RetailCategoryQueryDto, RetailProductQueryDto,
  UpdateRetailCategoryDto, UpdateRetailProductDto } from './retail-catalog.dto';
import { mapRetailCategory, mapRetailProduct } from './retail-catalog.mapper';
import { assertCategoryActive, assertRetailImage, categoryKey, categoryName, retailSku } from './retail-catalog.policy';
import { ProductRow, RetailCatalogRepository } from './retail-catalog.repository';
import { RetailCategory, RetailProduct } from './retail-catalog.schema';

const idOf = (id: string) => new Types.ObjectId(validateObjectId(id));
const missing = () => new ApplicationError(404, 'NOT_FOUND', 'Không tìm thấy danh mục hoặc sản phẩm');
const conflict = () => new ApplicationError(409, 'VERSION_CONFLICT', 'Dữ liệu đã thay đổi. Hãy tải lại trước khi lưu');
@Injectable()
export class RetailCatalogService {
  constructor(private readonly repository: RetailCatalogRepository, private readonly guards: DataGuardsService,
    private readonly idempotency: IdempotencyService) {}

  async categories(query: RetailCategoryQueryDto) {
    const result = await this.repository.list('CATEGORY', query);
    const items = [];
    for (const row of result.items as RetailCategory[]) items.push(mapRetailCategory(row, await this.repository.activeCount(row._id)));
    return { items, page: query.page, limit: query.limit, total: result.total, totalPages: Math.ceil(result.total / query.limit) };
  }
  async products(query: RetailProductQueryDto) {
    const result = await this.repository.list('PRODUCT', query);
    return { items: (result.items as ProductRow[]).map(row => mapRetailProduct(row, row.category)),
      page: query.page, limit: query.limit, total: result.total, totalPages: Math.ceil(result.total / query.limit) };
  }
  async category(id: string) {
    const row = await this.repository.category(idOf(id));
    if (!row) throw missing();
    return mapRetailCategory(row, await this.repository.activeCount(row._id));
  }
  async product(id: string) {
    const row = await this.repository.product(idOf(id));
    if (!row) throw missing();
    const category = await this.repository.category(row.category_id);
    if (!category) throw missing();
    return mapRetailProduct(row, category);
  }
  async saveCategory(actorId: string, input: CreateRetailCategoryDto | UpdateRetailCategoryDto, key: string, id?: string) {
    this.assertChanges(input);
    const target = id ? idOf(id) : undefined;
    const payload = { ...input, ...(input.name === undefined ? {} : { name: categoryName(input.name) }) };
    const operation = target ? 'CATEGORY_UPDATE' : 'CATEGORY_CREATE';
    await this.repository.assertWriterReady();
    try {
      return await this.idempotency.execute({ actorId, operation, clientKey: key, payload, targetId: target?.toHexString() }, async session => {
        await this.guards.acquire(session, { catalog: true });
        const actor = idOf(actorId);
        const old = target ? await this.repository.category(target, session) : null;
        if (target && !old) throw missing();
        if (old && (old.version !== (input as UpdateRetailCategoryDto).version || old.version === 2147483647)) throw conflict();
        const data = { name: payload.name ?? old!.name, name_key: categoryKey(payload.name ?? old!.name),
          status: input.status ?? old!.status, updated_by: actor };
        let row: RetailCategory;
        if (old) {
          const updated = await this.repository.categories.findOneAndUpdate({ _id: target, version: old.version },
            { $set: data, $inc: { version: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean().exec();
          if (!updated) throw conflict();
          row = updated;
        } else {
          const [created] = await this.repository.categories.create([{ ...data, created_by: actor, version: 0 }], { session });
          row = created.toObject();
        }
        const count = await this.repository.activeCount(row._id, session);
        const body = mapRetailCategory(row, count);
        await this.repository.insertEvent({ entity_type: 'CATEGORY', entity_id: row._id, actor_id: actor,
          action: action(old, row), before: old ? mapRetailCategory(old, count) : null, after: body,
          occurred_at: new Date(), request_key: transactionRequestKey(actorId, operation, key) }, session);
        return { status: old ? 200 : 201, body, resultIds: { categoryId: row._id } };
      });
    } catch (error) { return duplicate(error, 'CATEGORY_NAME_EXISTS', 'Tên danh mục đã tồn tại'); }
  }
  async saveProduct(actorId: string, input: CreateRetailProductDto | UpdateRetailProductDto, key: string, id?: string) {
    this.assertChanges(input);
    assertRetailImage(input.imageUrl?.trim());
    const target = id ? idOf(id) : undefined;
    const payload = { ...input,
      ...(input.categoryId === undefined ? {} : { categoryId: idOf(input.categoryId).toHexString() }),
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...('sku' in input ? { sku: retailSku(input.sku) } : {}),
      ...(input.price === undefined ? {} : { price: normalizeVnd(input.price) }),
      ...(input.description === undefined ? {} : { description: input.description?.trim() || null }),
      ...(input.imageUrl === undefined ? {} : { imageUrl: input.imageUrl?.trim() || null }),
    };
    const operation = target ? 'PRODUCT_UPDATE' : 'PRODUCT_CREATE';
    if (!target) {
      if (payload.description === null) delete payload.description;
      if (payload.imageUrl === null) delete payload.imageUrl;
    }
    await this.repository.assertWriterReady();
    try {
      return await this.idempotency.execute({ actorId, operation, clientKey: key, payload, targetId: target?.toHexString() }, async session => {
        await this.guards.acquire(session, { catalog: true });
        const old = target ? await this.repository.product(target, session) : null;
        if (target && !old) throw missing();
        if (old && (old.version !== (input as UpdateRetailProductDto).version || old.version === 2147483647)) throw conflict();
        const categoryId = payload.categoryId ? idOf(payload.categoryId) : old!.category_id;
        const category = await this.repository.category(categoryId, session);
        if (!category) throw missing();
        const status = input.status ?? old!.status;
        // Content/price edits preserve a SKU's raw ACTIVE intent under an INACTIVE category.
        // Newly activating a SKU, or moving an ACTIVE SKU, must recheck the target category.
        if (status === 'ACTIVE' && (!old || old.status !== 'ACTIVE' || !old.category_id.equals(categoryId))) assertCategoryActive(category.status);
        const actor = idOf(actorId);
        const data = { category_id: categoryId, name: payload.name ?? old!.name, status,
          price: payload.price === undefined ? old!.price : toVndDecimal(payload.price), updated_by: actor };
        let row: RetailProduct;
        if (old) {
          const set: Record<string, unknown> = { ...data }, unset: Record<string, 1> = {};
          for (const [apiField, dbField] of [['description', 'description'], ['imageUrl', 'image_url']] as const) {
            if (payload[apiField] === undefined) continue;
            if (payload[apiField] === null) unset[dbField] = 1;
            else set[dbField] = payload[apiField];
          }
          const updated = await this.repository.products.findOneAndUpdate({ _id: target, version: old.version },
            { $set: set, $unset: unset, $inc: { version: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean().exec();
          if (!updated) throw conflict();
          row = updated;
        } else {
          const [created] = await this.repository.products.create([{ ...data, sku: (payload as CreateRetailProductDto).sku,
            ...(payload.description ? { description: payload.description } : {}), ...(payload.imageUrl ? { image_url: payload.imageUrl } : {}),
            created_by: actor, version: 0 }], { session });
          row = created.toObject();
          await this.repository.insertInventory(row._id, session);
        }
        const oldCategory = old ? await this.repository.category(old.category_id, session) : null;
        const body = mapRetailProduct(row, category);
        await this.repository.insertEvent({ entity_type: 'PRODUCT', entity_id: row._id, actor_id: actor,
          action: action(old, row), before: old ? mapRetailProduct(old, oldCategory!) : null, after: body,
          occurred_at: new Date(), request_key: transactionRequestKey(actorId, operation, key) }, session);
        return { status: old ? 200 : 201, body, resultIds: { productId: row._id } };
      });
    } catch (error) { return duplicate(error, 'SKU_EXISTS', 'SKU đã tồn tại'); }
  }
  private assertChanges(input: object) {
    if ('version' in input && !Object.entries(input).some(([key, value]) => key !== 'version' && value !== undefined)) {
      throw new ApplicationError(400, 'VALIDATION_ERROR', 'Cần ít nhất một thay đổi');
    }
  }
}
function action(old: RetailCategory | RetailProduct | null, row: RetailCategory | RetailProduct) {
  return !old ? 'CREATED' : old.status === row.status ? 'UPDATED' : row.status === 'ACTIVE' ? 'ACTIVATED' : 'DEACTIVATED';
}
function duplicate(error: unknown, code: string, message: string): never {
  if (isDuplicateKey(error)) {
    const pattern = 'keyPattern' in (error as object) ? (error as { keyPattern: Record<string, unknown> }).keyPattern : {};
    if (pattern.name_key || pattern.sku) throw new ApplicationError(409, code, message);
    throw new ApplicationError(503, 'CATALOG_INTEGRITY_ERROR', 'Dữ liệu danh mục cần được kiểm tra trước khi thử lại cùng yêu cầu');
  }
  throw error;
}
