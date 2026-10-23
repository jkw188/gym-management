import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationError } from 'class-validator';
import { json, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { ApplicationError, ErrorDetail } from '../errors/application-error';
import { HttpErrorFilter } from './http-error.filter';
import cookieParser from 'cookie-parser';

function validationDetails(errors: ValidationError[], prefix = ''): ErrorDetail[] {
  return errors.flatMap(error => {
    // Unknown client-supplied property names must not be reflected into errors/logs.
    const field = error.constraints?.whitelistValidation ? 'unknownField' : `${prefix}${error.property}`;
    const own = Object.keys(error.constraints ?? {}).map(() => ({ field, message: 'Trường không hợp lệ hoặc không được phép' }));
    return [...own, ...validationDetails(error.children ?? [], `${field}.`)];
  });
}

export function configureHttp(app: INestApplication): void {
  const config = app.get(ConfigService);
  app.setGlobalPrefix('api');
  app.use((req: Request & { requestId?: string }, res: Response, next: NextFunction) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    if (req.path === '/api/auth' || req.path.startsWith('/api/auth/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({ origin: config.getOrThrow<string>('frontendOrigin'), credentials: true, exposedHeaders: ['X-Request-Id', 'Retry-After'] });
  app.use(cookieParser());
  app.use(json({ limit: '100kb' }));
  app.useGlobalPipes(new ValidationPipe({
    transform: true, whitelist: true, forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: errors => new ApplicationError(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', validationDetails(errors)),
  }));
  app.useGlobalFilters(new HttpErrorFilter());
  if (config.get('nodeEnv') !== 'production') {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Gym Management API').setVersion('1.0').addBearerAuth().build());
    SwaggerModule.setup('api/docs', app, document);
  }
}
