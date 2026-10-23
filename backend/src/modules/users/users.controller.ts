import { Body, Controller, Get, Param, Patch, Post, Query, UseFilters } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { Roles } from '../auth/auth.decorators';
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
@Roles('ADMIN')
@UseFilters(UsersHttpErrorFilter)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get() @ApiOkResponse({ type: UsersPageDto })
  list(@Query() query: ListUsersDto) { return this.users.list(query); }

  @Get('roles') @ApiOkResponse({ type: UserRolesDto })
  roles() { return this.users.listRoles(); }

  @Get(':id') @ApiOkResponse({ type: UserResponseDto })
  detail(@Param('id') id: string) { return this.users.detail(id); }

  @Post() @ApiCreatedResponse({ type: UserResponseDto })
  create(@Body() input: CreateUserDto) { return this.users.create(input); }

  @Patch(':id') @ApiOkResponse({ type: UserResponseDto })
  update(@Param('id') id: string, @Body() input: UpdateUserDto) { return this.users.update(id, input); }
}
