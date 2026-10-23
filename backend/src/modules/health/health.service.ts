import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Injectable()
export class HealthService {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  live() { return { status: 'ok' as const }; }
  async ready() {
    if (this.connection.readyState !== 1 || !this.connection.db) throw new ServiceUnavailableException();
    try { await this.connection.db.command({ ping: 1 }, { timeoutMS: 1500 }); }
    catch { throw new ServiceUnavailableException(); }
    return { status: 'ready' as const };
  }
}
