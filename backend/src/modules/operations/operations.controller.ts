// Tầng API (EN-02 bước 3): GET /api/operations/:operation/:key cho client hỏi lại kết quả lệnh khi mất response.
// actor lấy từ token đăng nhập; không nhận actorId từ query (EN-02-TC15).
import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthPrincipal } from '../auth/auth.types';
import { IdempotencyService } from './idempotency.service';
import { OperationLookupParamsDto, OperationLookupResponseDto } from './operations.dto';

@ApiTags('operations')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@Controller('operations')
export class OperationsController {
  constructor(private readonly idempotency: IdempotencyService) {}

  // Guard toàn cục đã kiểm token (401); quyền theo từng operation và quyền sở hữu do service kiểm.
  @Get(':operation/:key') @ApiOkResponse({ type: OperationLookupResponseDto })
  lookup(@CurrentUser() user: AuthPrincipal, @Param() params: OperationLookupParamsDto) {
    return this.idempotency.lookup(user, params.operation, params.key);
  }
}
