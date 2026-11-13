import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import request from 'supertest';
import { createTestDatabase, TestDatabase } from '../../scripts/test-database.cjs';
import { configureHttp } from '../../src/common/http/configure-http';
import { PasswordService } from '../../src/common/security/password.service';
import { LoginLimiter } from '../../src/modules/auth/login-limiter.service';
import { AccessCatalogService } from '../../src/modules/users/access-catalog.service';
import { Account } from '../../src/modules/users/schemas/account.schema';
import { RoleCode, ROLE_CODES } from '../../src/modules/users/schemas/role.schema';
import { ACCOUNT_ADMINISTRATION, SecurityState } from '../../src/modules/users/schemas/security-state.schema';
import { UsersRepository } from '../../src/modules/users/users.repository';

export const origin = 'http://localhost:5173';
export const password = 'EN04 fixture password 123';
export const reason = 'Kiểm tra hồi quy Sprint 1';
export interface LoginSession { token: string; cookie: string }

export class S01Fixture {
  private database?: TestDatabase;
  readonly apps: INestApplication[] = [];
  private readonly savedEnv = { ...process.env };
  private hash = '';
  private sequence = 0;
  users!: Record<RoleCode, Account>;
  sessions!: Record<RoleCode, LoginSession>;
  get app() { return this.apps[0]; }
  get connection() { return this.app.get<Connection>(getConnectionToken()); }
  get accounts() { return this.app.get<Model<Account>>(getModelToken('Account')); }

  async start() {
    try {
      this.database = await createTestDatabase({ ...process.env }, 's01');
      Object.assign(process.env, { MONGODB_URI: process.env.MONGODB_TEST_URI, MONGODB_DB: this.database.name });
      const { AppModule } = await import('../../src/app.module');
      for (let index = 0; index < 2; index++) {
        const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
        const app = module.createNestApplication({ logger: false, bodyParser: false });
        this.apps.push(app);
        configureHttp(app);
        await app.init();
        await Promise.all(Object.values(app.get<Connection>(getConnectionToken()).models).map(model => model.init()));
      }
      this.hash = await this.app.get(PasswordService).hash(password);
    } catch (error) { await this.close(); throw error; }
  }

  async reset() {
    // Isolate the in-memory rate-limit window too; execute the real limiter, JWT, sessions and guards.
    for (const app of this.apps) {
      const limiter = new LoginLimiter();
      jest.spyOn(app.get(LoginLimiter), 'consume').mockImplementation(limiter.consume.bind(limiter));
    }
    await this.database!.reset();
    await this.app.get(AccessCatalogService).seed();
    await this.app.get<Model<SecurityState>>(getModelToken('SecurityState')).create({ _id: ACCOUNT_ADMINISTRATION, revision: 0n });
    this.users = {} as Record<RoleCode, Account>;
    this.sessions = {} as Record<RoleCode, LoginSession>;
    for (const code of ROLE_CODES) {
      this.users[code] = await this.account(code);
      this.sessions[code] = await this.login(this.users[code].phone);
    }
  }

  async account(code: RoleCode) {
    const repository = this.app.get(UsersRepository);
    const role = await repository.findRoleByCode(code);
    return repository.createAccount({ roleId: role!.id.toHexString(), fullName: `EN04 ${code}`,
      phone: `099${String(++this.sequence).padStart(7, '0')}`, passwordHash: this.hash });
  }

  async login(phone: string, app = this.app): Promise<LoginSession> {
    const response = await request(app.getHttpServer()).post('/api/auth/login').set('Origin', origin).send({ phone, password }).expect(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    return { token: response.body.accessToken as string, cookie: cookies[0].split(';')[0] };
  }

  async close() {
    try {
      const results = await Promise.allSettled(this.apps.splice(0).map(app => app.close()));
      await this.database?.close();
      this.database = undefined;
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } finally { process.env = this.savedEnv; }
  }
}
