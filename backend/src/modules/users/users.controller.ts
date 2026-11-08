import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseFilters } from '@nestjs/common';
import { Request } from 'express';
import { AuthPrincipal } from '../auth/auth.types';
import { AccountSecurityService } from './account-security.service';
import { ChangeRoleDto, ChangeSecurityResponseDto, ChangeStatusDto } from './account-security.dto';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { FixedPermission } from './access.policy';
import { CreateUserDto, ListUsersDto, UpdateUserDto, UserResponseDto, UserRolesDto, UsersPageDto } from './users.dto';
import { UsersHttpErrorFilter } from './users-http-error.filter';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@UseFilters(UsersHttpErrorFilter)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService, private readonly security: AccountSecurityService) {}

  @Patch(':id/role') @FixedPermission('accounts.changeRole') @ApiOkResponse({ type: ChangeSecurityResponseDto })
  changeRole(@Param('id') id: string, @Body() input: ChangeRoleDto,
    @Req() req: Request & { user: AuthPrincipal; requestId: string }) {
    return this.security.changeRole(req.user, id, input, req.requestId);
  }

  @Patch(':id/status') @FixedPermission('accounts.changeStatus') @ApiOkResponse({ type: ChangeSecurityResponseDto })
  changeStatus(@Param('id') id: string, @Body() input: ChangeStatusDto,
    @Req() req: Request & { user: AuthPrincipal; requestId: string }) {
    return this.security.changeStatus(req.user, id, input, req.requestId);
  }

  @Get() @FixedPermission('accounts.read') @ApiOkResponse({ type: UsersPageDto })
  list(@Query() query: ListUsersDto) { return this.users.list(query); }

  @Get('roles') @FixedPermission('accounts.read') @ApiOkResponse({ type: UserRolesDto })
  roles() { return this.users.listRoles(); }

  @Get(':id') @FixedPermission('accounts.read') @ApiOkResponse({ type: UserResponseDto })
  detail(@Param('id') id: string) { return this.users.detail(id); }

  @Post() @FixedPermission('accounts.create') @ApiCreatedResponse({ type: UserResponseDto })
  create(@Body() input: CreateUserDto) { return this.users.create(input); }

  @Patch(':id') @FixedPermission('accounts.update') @ApiOkResponse({ type: UserResponseDto })
  update(@Param('id') id: string, @Body() input: UpdateUserDto) { return this.users.update(id, input); }
}
