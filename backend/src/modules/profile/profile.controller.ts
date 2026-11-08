import { Body, Controller, Get, Patch, UseFilters } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/http/error.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { FixedPermission } from '../users/access.policy';
import { AuthPrincipal } from '../auth/auth.types';
import { UsersHttpErrorFilter } from '../users/users-http-error.filter';
import { ProfileResponseDto, UpdateProfileDto, UpdateProfileResponseDto } from './profile.dto';
import { ProfileService } from './profile.service';

@ApiTags('profile')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@UseFilters(UsersHttpErrorFilter)
@Controller('profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get('me') @FixedPermission('profile.readOwn') @ApiOkResponse({ type: ProfileResponseDto })
  me(@CurrentUser() user: AuthPrincipal) {
    return this.profile.get(user);
  }

  @Patch('me') @FixedPermission('profile.updateOwn') @ApiOkResponse({ type: UpdateProfileResponseDto })
  update(@CurrentUser() user: AuthPrincipal, @Body() input: UpdateProfileDto) {
    return this.profile.update(user, input);
  }
}
