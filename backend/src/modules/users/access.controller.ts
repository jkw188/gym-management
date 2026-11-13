import { Controller, Get, UseFilters } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { ROLE_CODES, RoleCode } from './schemas/role.schema';
import { FixedPermission } from './access.policy';
import { AccessCatalogService } from './access-catalog.service';
import { UsersHttpErrorFilter } from './users-http-error.filter';

class PermissionDto {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}
class AccessRoleDto {
  @ApiProperty({ enum: ROLE_CODES }) code!: RoleCode;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [PermissionDto] }) permissions!: PermissionDto[];
}
export class AccessRolesDto {
  @ApiProperty({ type: [AccessRoleDto] }) items!: AccessRoleDto[];
}

@ApiTags('access') @ApiBearerAuth()
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@UseFilters(UsersHttpErrorFilter)
@Controller('access')
export class AccessController {
  constructor(private readonly catalog: AccessCatalogService) {}

  @Get('roles') @FixedPermission('accounts.changeRole') @ApiOkResponse({ type: AccessRolesDto })
  roles() { return this.catalog.list(); }
}
