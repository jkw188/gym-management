import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { TransactionModule } from '../../infrastructure/transaction/transaction.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthOriginGuard, JwtAuthGuard, RolesGuard } from './auth.guards';
import { AuthService } from './auth.service';
import { AuthRateLimitsRepository } from './auth-rate-limits.repository';
import { AuthSessionsRepository } from './auth-sessions.repository';
import { ChangePasswordLimiter } from './change-password-limiter.service';
import { AuthRateLimitSchema } from './schemas/auth-rate-limit.schema';
import { JwtStrategy } from './jwt.strategy';
import { LoginLimiter } from './login-limiter.service';
import { RegistrationGuard, RegistrationLimiter } from './registration.guard';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetLimiter } from './password-reset-limiter.service';
import { PasswordResetMailer } from './password-reset-mailer.service';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetsRepository } from './password-resets.repository';
import { PasswordResetSchema } from './schemas/password-reset.schema';
import { AuthSessionSchema } from './schemas/auth-session.schema';

@Module({
  imports: [UsersModule, TransactionModule, PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    MongooseModule.forFeature([{ name: 'AuthSession', schema: AuthSessionSchema }, { name: 'AuthRateLimit', schema: AuthRateLimitSchema },
      { name: 'PasswordReset', schema: PasswordResetSchema }]),
    JwtModule.registerAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({
      secret: config.getOrThrow<string>('jwtAccessSecret'),
      signOptions: { algorithm: 'HS256', issuer: config.getOrThrow<string>('jwtIssuer'), audience: config.getOrThrow<string>('jwtAudience') },
    }) })],
  controllers: [AuthController, PasswordResetController],
  providers: [AuthService, AuthSessionsRepository, AuthRateLimitsRepository, ChangePasswordLimiter,
    PasswordResetService, PasswordResetsRepository, PasswordResetLimiter, PasswordResetMailer,
    JwtStrategy, LoginLimiter, RegistrationGuard, RegistrationLimiter, AuthOriginGuard, JwtAuthGuard, RolesGuard,
    { provide: APP_GUARD, useExisting: JwtAuthGuard }, { provide: APP_GUARD, useExisting: RolesGuard }],
  exports: [AuthService, JwtAuthGuard, RolesGuard, PassportModule],
})
export class AuthModule {}
