import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import * as os from 'node:os';

@Module({
  imports: [MongooseModule.forRootAsync({
    imports: [ConfigModule], inject: [ConfigService],
    useFactory: (config: ConfigService) => ({
      uri: config.getOrThrow<string>('mongoUri'), dbName: config.getOrThrow<string>('mongoDb'),
      serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, socketTimeoutMS: 10_000,
      retryAttempts: 1, verboseRetryLog: false, bufferCommands: false,
      // NODE-7832: explicitly use Node's OS adapter; dynamic imports fail inside Jest's VM.
      runtimeAdapters: { os },
      autoIndex: config.get('nodeEnv') !== 'production',
      autoCreate: config.get('nodeEnv') !== 'production',
      connectionErrorFactory: error => new Error('DATABASE_CONNECTION_FAILED', { cause: error }),
    }),
  })],
  exports: [MongooseModule],
})
export class DatabaseModule {}
