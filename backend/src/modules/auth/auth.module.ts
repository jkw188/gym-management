import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthOriginGuard, JwtAuthGuard, RolesGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { AuthSessionsRepository } from './auth-sessions.repository';
import { JwtStrategy } from './jwt.strategy';
import { LoginLimiter } from './login-limiter.service';
import { AuthSessionSchema } from './schemas/auth-session.schema';

@Module({
  imports: [UsersModule, PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    MongooseModule.forFeature([{ name: 'AuthSession', schema: AuthSessionSchema }]),
    JwtModule.registerAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({
      secret: config.getOrThrow<string>('jwtAccessSecret'),
      signOptions: { algorithm: 'HS256', issuer: config.getOrThrow<string>('jwtIssuer'), audience: config.getOrThrow<string>('jwtAudience') },
    }) })],
  controllers: [AuthController],
  providers: [AuthService, AuthSessionsRepository, JwtStrategy, LoginLimiter, AuthOriginGuard, JwtAuthGuard, RolesGuard,
    { provide: APP_GUARD, useExisting: JwtAuthGuard }, { provide: APP_GUARD, useExisting: RolesGuard }],
  exports: [AuthService, JwtAuthGuard, RolesGuard, PassportModule],
})
export class AuthModule {}
