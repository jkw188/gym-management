import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { ApplicationError } from '../../common/errors/application-error';
import { RoleCode } from '../users/schemas/role.schema';
import { PUBLIC_ROUTE, REQUIRED_ROLES } from './auth.decorators';
import { AuthPrincipal } from './auth.types';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) { super(); }
  canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) return true;
    return super.canActivate(context);
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<RoleCode[]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]);
    if (!roles?.length) return true;
    const user = context.switchToHttp().getRequest<{ user?: AuthPrincipal }>().user;
    if (!user) throw new ApplicationError(401, 'UNAUTHORIZED', 'Cần xác thực');
    if (!roles.includes(user.roleCode)) throw new ApplicationError(403, 'FORBIDDEN', 'Không có quyền truy cập');
    return true;
  }
}

@Injectable()
export class AuthOriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.headers.origin !== this.config.getOrThrow<string>('frontendOrigin')) {
      throw new ApplicationError(403, 'INVALID_ORIGIN', 'Nguồn yêu cầu không hợp lệ');
    }
    if (!req.is('application/json') || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new ApplicationError(400, 'VALIDATION_ERROR', 'Yêu cầu phải có body JSON object');
    }
    return true;
  }
}
