// Tầng nghiệp vụ (EN-02 bước 3): chống xử lý lặp theo Idempotency-Key và tra cứu kết quả lệnh đã commit.
// Cùng actor + operation + key chỉ có một kết quả; gửi lại thì trả lại kết quả gốc, không ghi thêm.
import { Injectable } from '@nestjs/common';
import { ClientSession, MongoServerError } from 'mongodb';
import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { ApplicationError } from '../../common/errors/application-error';
import { TransactionRunner } from '../../infrastructure/transaction/transaction-runner';
import { AuthPrincipal } from '../auth/auth.types';
import { RoleCode } from '../users/schemas/role.schema';
import { OperationRequestsRepository } from './operation-requests.repository';
import { Operation } from './schemas/operation-request.schema';

// Lệnh nghiệp vụ cần chống lặp. actorId lấy từ người đang đăng nhập, không nhận từ client (EN-02-F04).
export interface IdempotentCommand {
  actorId: string;
  operation: Operation;
  clientKey: string;
  payload: Record<string, unknown>; // DTO đã chuẩn hóa
  targetId?: string;                // id đối tượng bị tác động (vd transaction cần thu tiền)
}

// Kết quả work trả về: mã HTTP, body cho client và các id đã tạo.
export interface WorkResult { status: number; body: Record<string, unknown>; resultIds: Record<string, unknown> }
export interface OperationResult { status: number; body: Record<string, unknown> }

// Catalog quyền: năm thao tác S02 dành cho STAFF và ADMIN; ca nháp S04 chỉ dành cho TRAINER (US-24-F01).
const OPERATION_ROLES: Record<Operation, RoleCode[]> = {
  SALE_REGISTER: ['STAFF', 'ADMIN'],
  SALE_CANCEL: ['STAFF', 'ADMIN'],
  PAYMENT_CONFIRM: ['STAFF', 'ADMIN'],
  MEMBER_CREATE: ['STAFF', 'ADMIN'],
  MEMBER_LINK: ['STAFF', 'ADMIN'],
  SHIFT_CREATE: ['TRAINER'],
  SHIFT_UPDATE: ['TRAINER'],
};

// Số lần thử lại khi hai request cùng key chạy đua và request này thua ở unique index.
const MAX_DUPLICATE_RETRIES = 3;

@Injectable()
export class IdempotencyService {
  constructor(private readonly transactions: TransactionRunner, private readonly requests: OperationRequestsRepository) {}

  // Chạy work đúng một lần cho mỗi key. work ghi bằng session được truyền vào; record kết quả được insert
  // trong CÙNG transaction, nên work lỗi thì cả dữ liệu nghiệp vụ lẫn record đều rollback (EN-02-TC07).
  async execute(command: IdempotentCommand, work: (session: ClientSession) => Promise<WorkResult>): Promise<OperationResult> {
    const actorId = new Types.ObjectId(command.actorId);
    const requestHash = hashRequest(command.payload, command.targetId);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.transactions.run(async session => {
          const existing = await this.requests.findByKey(actorId, command.operation, command.clientKey, session);
          if (existing) {
            // EN-02-TC06: cùng key nhưng payload/target khác sau chuẩn hóa thì từ chối, không ghi thêm.
            if (existing.request_hash !== requestHash) {
              throw new ApplicationError(409, 'IDEMPOTENCY_CONFLICT', 'Khóa yêu cầu đã dùng cho dữ liệu khác');
            }
            // EN-02-TC04, EN-02-TC07: trả lại đúng mã HTTP và body gốc, không chạy work lần nữa.
            return { status: existing.response_status, body: existing.response_body };
          }

          const result = await work(session);
          await this.requests.insert({
            actorId, operation: command.operation, clientKey: command.clientKey, requestHash,
            resultIds: result.resultIds, responseStatus: result.status, responseBody: result.body, committedAt: new Date(),
          }, session);
          return { status: result.status, body: result.body };
        });
      } catch (error) {
        // EN-02-TC05: hai request cùng key chạy đua, unique index chặn request thua và transaction của nó bị abort.
        // Thử lại cùng key để đọc record của request thắng; quá số lần thì ném lỗi, không báo thành công giả.
        // Trùng index nghiệp vụ khác (vd payments.reference) là lỗi nghiệp vụ: ném ngay, không retry (EN-02-F03).
        if (isOperationKeyDuplicate(error)) {
          if (attempt < MAX_DUPLICATE_RETRIES) continue;
          // Hết lượt thử mà vẫn trùng key: không biết kết quả, client giữ nguyên key để hỏi lại (EN-02 mục transaction).
          throw new ApplicationError(503, 'OPERATION_OUTCOME_UNKNOWN', 'Chưa xác định được kết quả. Hãy kiểm tra lại hoặc gửi lại với cùng khóa');
        }
        throw error;
      }
    }
  }

  // API lookup: chỉ chủ sở hữu còn quyền thực hiện operation mới xem được kết quả (EN-02-TC15).
  async lookup(principal: AuthPrincipal, operation: Operation, clientKey: string) {
    // EN-02-TC15: role hiện tại không được thực hiện operation thì 403.
    if (!OPERATION_ROLES[operation].includes(principal.roleCode)) {
      throw new ApplicationError(403, 'FORBIDDEN', 'Không có quyền truy cập');
    }
    // EN-02-TC15: chỉ tìm theo actor đang đăng nhập, nên key của người khác cũng ra 404, không lộ kết quả.
    const record = await this.requests.findByKey(new Types.ObjectId(principal.id), operation, clientKey);
    if (!record) {
      // EN-02-TC08: chưa thấy không có nghĩa là thất bại; request gốc có thể vẫn đang chạy.
      throw new ApplicationError(404, 'OPERATION_UNKNOWN', 'Chưa thấy kết quả. Yêu cầu có thể vẫn đang xử lý, chỉ gửi lại với cùng khóa');
    }
    return { status: 'COMMITTED' as const, responseStatus: record.response_status, responseBody: record.response_body };
  }
}

// EN-02-D01: request_hash = SHA-256 của DTO đã chuẩn hóa cộng targetId. Chỉ lưu hash, không lưu payload (EN-02-TC16).
function hashRequest(payload: Record<string, unknown>, targetId = ''): string {
  return createHash('sha256').update(`${canonicalJson(payload)}|${targetId}`).digest('hex');
}

// Sắp xếp key của object theo thứ tự chữ cái (cả object lồng nhau), để đổi thứ tự field vẫn ra cùng chuỗi (EN-02-TC04).
// Date đổi thành chuỗi ISO để khác ngày thì khác hash; field undefined bị bỏ như JSON.stringify (EN-02-TC06).
function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Mã 11000 là vi phạm MỘT unique index nào đó; keyPattern cho biết index nào.
// Chỉ coi là chạy đua cùng key khi trùng đúng index (actor_id, operation, client_key) của operation_requests.
function isOperationKeyDuplicate(error: unknown): boolean {
  if (!(error instanceof MongoServerError) || error.code !== 11000) return false;
  return JSON.stringify(error.keyPattern) === JSON.stringify({ actor_id: 1, operation: 1, client_key: 1 });
}
