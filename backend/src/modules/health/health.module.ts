import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { EnvironmentCheck } from '../../infrastructure/environment/environment-check';

@Module({ controllers: [HealthController], providers: [HealthService, EnvironmentCheck], exports: [EnvironmentCheck] })
export class HealthModule {}
