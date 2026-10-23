import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureHttp } from './common/http/configure-http';
import { ConfigurationError } from './config/configuration';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
  const config = app.get(ConfigService);
  configureHttp(app);
  app.enableShutdownHooks();
  try { await app.listen(config.getOrThrow<number>('port')); }
  catch (error) { await app.close(); throw error; }
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), code: 'APPLICATION_STARTED' }));
}
void bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), code: 'STARTUP_FAILED',
    message: error instanceof ConfigurationError ? error.message : 'Startup failed; check database availability and run npm run ensure-indexes' }));
  process.exitCode = 1;
});
