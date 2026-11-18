import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureHttp } from './common/http/configure-http';
import { ConfigurationError } from './config/configuration';
import { NotificationOutboxService } from './modules/notifications/notification-outbox.service';
import { OrderExpiryWorker } from './modules/orders/order-expiry.worker';
import { RemindersWorker } from './modules/reminders/reminders.worker';
import { EnvironmentCheck } from './infrastructure/environment/environment-check';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
  const config = app.get(ConfigService);
  configureHttp(app);
  app.enableShutdownHooks();
  try {
    // UAT must fail closed before opening the HTTP port, including transaction rollback capability.
    if (config.get('deploymentEnvironment') === 'uat') {
      await app.init();
      await app.get(EnvironmentCheck).assertReady();
    }
    await app.listen(config.getOrThrow<number>('port'));
  }
  catch (error) { await app.close(); throw error; }
  // EN-03 spec 1.2 (TC18): chỉ tiến trình HTTP server chạy outbox worker; app.close() sẽ tắt worker.
  app.get(NotificationOutboxService).start();
  app.get(OrderExpiryWorker).start();
  app.get(RemindersWorker).start();
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), code: 'APPLICATION_STARTED' }));
}
void bootstrap().catch((error: unknown) => {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), code: 'STARTUP_FAILED',
    message: error instanceof ConfigurationError ? error.message : 'Startup failed; check database availability and run npm run ensure-indexes' }));
  process.exitCode = 1;
});
