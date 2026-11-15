// Tầng nghiệp vụ (US-18 bước 1–2): adapter cho Member tự đăng ký gói – tìm hồ sơ của chính account đang đăng nhập
// rồi gọi lại đúng REGISTER_V1/hủy của SalesService (US-14), không viết lại công thức giá/ngày/điều kiện cấp gói (US-18-F02).
// Bước 2: ghi kênh SELF_SERVICE + cách trả dự kiến, Member tự hủy yêu cầu của mình, hướng dẫn thanh toán.
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../../common/errors/application-error';
import { ReceivingAccountPolicy } from '../../common/utils/receiving-account';
import { fromVndDecimal } from '../../common/utils/vnd-money';
import { MemberOwnerReader } from '../members/member-owner.reader';
import { MeRegisterSaleDto } from './me-sales.dto';
import { CancelSaleDto, RegisterSaleDto } from './sales.dto';
import { SalesRepository } from './sales.repository';
import { SalesService, objectId } from './sales.service';

// Hướng dẫn trả tiền mặt hiển thị cho mọi giao dịch còn phải trả (spec mục 2: cashInstruction).
const CASH_INSTRUCTION = 'Thanh toán tiền mặt tại quầy lễ tân, đọc mã giao dịch cho nhân viên. Gói chỉ có hiệu lực sau khi nhân viên xác nhận đã thu đủ.';

@Injectable()
export class MeSalesService {
  constructor(private readonly owners: MemberOwnerReader, private readonly sales: SalesService,
    private readonly repository: SalesRepository, private readonly accounts: ReceivingAccountPolicy) {}

  // US-18-TC01: quote giống hệt quầy vì dùng chung SalesService.preview.
  async preview(accountId: string, dto: MeRegisterSaleDto) {
    const input = await this.toCounterInput(accountId, dto);
    return this.sales.preview(input);
  }

  // US-18-TC01: actorId = account Member nên created_by của giao dịch là principal; kênh SELF_SERVICE do server đặt.
  // US-18-TC03, TC04: mọi kiểm tra và snapshot giá do SalesService.create làm, giống quầy.
  // US-18-TC09: owner được kiểm lại TRƯỚC khi tra key, nên replay sau khi gỡ liên kết vẫn bị 409.
  async create(accountId: string, dto: MeRegisterSaleDto, key: string) {
    const input = await this.toCounterInput(accountId, dto);
    return this.sales.create(accountId, input, key, { channel: 'SELF_SERVICE', preferredPaymentMethod: dto.preferredPaymentMethod });
  }

  // US-18-F04, US-18-TC11: Member chỉ hủy sale SELF_SERVICE do chính account tạo; trạng thái/version/đã thu do SalesService.cancel kiểm.
  async cancel(accountId: string, saleId: string, dto: CancelSaleDto, key: string) {
    const id = objectId(saleId);
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    // Chưa liên kết hoặc sale của người khác → 404, không lộ là sale có tồn tại.
    const sale = memberId ? await this.repository.findOwnSale(memberId, id) : null;
    if (!sale) throw new ApplicationError(404, 'SALE_NOT_FOUND', 'Không tìm thấy lần mua gói');
    const transaction = await this.repository.findOwnTransaction(sale.member_id, sale.transaction_id);
    // Sale tại quầy (hoặc không do chính account này tạo) phải để nhân viên hủy → 403.
    const createdBySelf = transaction?.created_by?.equals(new Types.ObjectId(accountId)) === true;
    if (sale.channel !== 'SELF_SERVICE' || !createdBySelf) {
      throw new ApplicationError(403, 'FORBIDDEN', 'Yêu cầu này do quầy tạo, hãy liên hệ nhân viên để hủy');
    }
    return this.sales.cancel(accountId, saleId, dto, key);
  }

  // US-18-TC07: hướng dẫn thanh toán của giao dịch của chính mình; số tiền và mã lấy từ giao dịch trên server.
  async paymentInstructions(accountId: string, transactionId: string) {
    const id = objectId(transactionId);
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    const transaction = memberId ? await this.repository.findOwnTransaction(memberId, id) : null;
    if (!transaction) throw new ApplicationError(404, 'TRANSACTION_NOT_FOUND', 'Không tìm thấy giao dịch');
    const amountDue = fromVndDecimal(transaction.amount_due);
    // Gói 0đ không cần trả; kiểm trước trạng thái vì giao dịch 0đ đã SETTLED ngay khi tạo.
    if (amountDue === '0') throw new ApplicationError(409, 'NO_PAYMENT_REQUIRED', 'Giao dịch này không cần thanh toán');
    if (transaction.status !== 'PENDING') {
      throw new ApplicationError(409, 'INVALID_TRANSACTION_STATE', 'Trạng thái giao dịch không cho phép thao tác');
    }
    const sale = await this.repository.findSaleByTransaction(transaction._id);
    const preferred = sale?.preferred_payment_method;
    // US-18-TC08: thiếu cấu hình thì không có tài khoản nào, không bao giờ đưa tài khoản mẫu.
    // Nội dung chuyển khoản = mã giao dịch của server, không dùng reference ngân hàng.
    const transferOptions = preferred === 'TRANSFER' ? this.accounts.transferAccounts().map(account => ({
      receivingAccountCode: account.code, bankName: account.bankName, accountNumber: account.accountNumber,
      accountName: account.accountName, transferContent: transaction.code,
    })) : [];
    return {
      transactionCode: transaction.code, amountDue, cashInstruction: CASH_INSTRUCTION,
      ...(preferred ? { preferredPaymentMethod: preferred } : {}),
      ...(transferOptions.length > 0 ? { transferOptions } : {}),
    };
  }

  // US-18-F01: memberId chỉ lấy từ members.account_id = principal (resolver US-17), không lấy từ body.
  private async toCounterInput(accountId: string, dto: MeRegisterSaleDto): Promise<RegisterSaleDto> {
    const memberId = await this.owners.findMemberIdOfAccount(accountId);
    // US-18-TC02: chưa liên kết → 409, không tự nối hồ sơ dù trùng số điện thoại.
    if (!memberId) throw new ApplicationError(409, 'MEMBER_PROFILE_REQUIRED', 'Tài khoản chưa được liên kết hồ sơ hội viên. Hãy liên hệ quầy');
    // US-18-TC08: chọn TRANSFER khi chưa cấu hình tài khoản nhận → 503 ngay ở preview/tạo, để chọn CASH trước.
    if (dto.preferredPaymentMethod === 'TRANSFER') this.accounts.assertTransferAvailable();
    return { memberId: memberId.toHexString(), planId: dto.planId, planVersion: dto.planVersion, startDate: dto.startDate };
  }
}
