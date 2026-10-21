import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.getOrThrow<string>('frontendOrigin') });
  app.enableShutdownHooks();
  await app.listen(config.getOrThrow<number>('port'));
}
void bootstrap().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
