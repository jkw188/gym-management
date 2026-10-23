import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { RoleCode } from '../users/schemas/role.schema';
import { AuthPrincipal } from './auth.types';

export const PUBLIC_ROUTE = 'auth:public';
export const REQUIRED_ROLES = 'auth:roles';
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const Roles = (...roles: RoleCode[]) => SetMetadata(REQUIRED_ROLES, roles);
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthPrincipal => context.switchToHttp().getRequest<{ user: AuthPrincipal }>().user);
