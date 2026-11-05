import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from './auth.service';

// Dùng chung để Guard và đổi mật khẩu (US-67) đọc header Authorization theo cùng một cách.
export const extractAccessToken = ExtractJwt.fromAuthHeaderAsBearerToken();

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private readonly auth: AuthService) {
    super({ jwtFromRequest: extractAccessToken,
      secretOrKey: config.getOrThrow<string>('jwtAccessSecret'), algorithms: ['HS256'],
      issuer: config.getOrThrow<string>('jwtIssuer'), audience: config.getOrThrow<string>('jwtAudience'),
      ignoreExpiration: false, jsonWebTokenOptions: { clockTolerance: 0 } });
  }
  validate(payload: unknown) { return this.auth.validateAccess(payload); }
}
