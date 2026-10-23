import { BadRequestException, ForbiddenException, HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ApplicationError } from '../src/common/errors/application-error';
import { mapError } from '../src/common/http/http-error.filter';
import { PasswordService } from '../src/common/security/password.service';
import { normalizeEmail, normalizeFullName, normalizePhone, validateObjectId } from '../src/common/utils/normalization';
import { readConfiguration } from '../src/config/configuration';
import { mapAccount } from '../src/modules/users/account.mapper';

const validEnv = { MONGODB_URI: 'mongodb://127.0.0.1:27017', MONGODB_DB: 'gym_management_test' };

describe('TC01–02 configuration', () => {
  it('uses documented development defaults and rejects missing/invalid variables without leaking values', () => {
    expect(readConfiguration(validEnv)).toMatchObject({ port: 3000, nodeEnv: 'development', frontendOrigin: 'http://localhost:5173' });
    for (const extra of [{ MONGODB_URI: '' }, { MONGODB_DB: '' }, { PORT: 'abc' }, { PORT: '1.5' }, { PORT: '65536' },
      { FRONTEND_ORIGIN: 'http://localhost:5173/path' }, { FRONTEND_ORIGIN: 'http://localhost:5173/' },
      { FRONTEND_ORIGIN: 'https://user:secret@example.com' }, { NODE_ENV: 'invalid' }]) {
      expect(() => readConfiguration({ ...validEnv, ...extra })).toThrow('Invalid environment variables');
    }
    try { readConfiguration({ ...validEnv, MONGODB_URI: 'secret-value' }); }
    catch (error) { expect((error as Error).message).toContain('MONGODB_URI'); expect((error as Error).message).not.toContain('secret-value'); }
  });
  it('requires explicit production port/origin and an isolated test database', () => {
    expect(() => readConfiguration({ ...validEnv, NODE_ENV: 'production' })).toThrow('PORT, FRONTEND_ORIGIN');
    expect(() => readConfiguration({ ...validEnv, NODE_ENV: 'test', MONGODB_DB: 'gym_management' })).toThrow('MONGODB_DB');
    expect(readConfiguration({ ...validEnv, NODE_ENV: 'test' }).mongoDb).toBe('gym_management_test');
  });
});

describe('TC05 normalization and identifiers', () => {
  it.each(['0901234567', '84901234567', '+84 901 234 567', '(090) 123-45.67'])('normalizes %s', input => {
    expect(normalizePhone(input)).toBe('+84901234567');
  });
  it.each(['abc', '090abc4567', '+012345678', '+1234', '++84901234567', '(0901234567', '()0901234567', '((090))1234567'])('rejects %s', input => {
    expect(() => normalizePhone(input)).toThrow(ApplicationError);
  });
  it('normalizes names and optional email without modifying passwords', () => {
    expect(normalizeFullName('  Nguyễn   Văn A  ')).toBe('Nguyễn Văn A');
    expect(normalizeEmail(' ADMIN@EXAMPLE.COM ')).toBe('admin@example.com');
    expect(normalizeEmail('   ')).toBeUndefined();
    expect(() => normalizeEmail('invalid')).toThrow(ApplicationError);
    expect(() => normalizeFullName('A')).toThrow(ApplicationError);
    expect(() => normalizeFullName('A'.repeat(121))).toThrow(ApplicationError);
    expect(() => validateObjectId('not-an-id')).toThrow(ApplicationError);
    expect(validateObjectId('a'.repeat(24))).toBe('a'.repeat(24));
  });
});

describe('TC08 Argon2id', () => {
  const passwords = new PasswordService();
  it('uses independent salts, verifies exact Unicode password without trimming', async () => {
    const password = '  Mật khẩu thử nghiệm  ';
    const first = await passwords.hash(password);
    const second = await passwords.hash(password);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await passwords.verify(first, password)).toBe(true);
    expect(await passwords.verify(first, password.trim())).toBe(false);
    expect(await passwords.verify(first, 'wrong password')).toBe(false);
    expect(await passwords.verify('invalid-hash', password)).toBe(false);
    expect(await passwords.hash('😀'.repeat(128))).toMatch(/^\$argon2id\$/);
    await expect(passwords.hash('a'.repeat(129))).rejects.toThrow(ApplicationError);
    await expect(passwords.hash('short')).rejects.toThrow(ApplicationError);
  });
});

describe('TC13 safe errors and account API mapper', () => {
  it('preserves status and maps database errors without exposing internal messages', () => {
    for (const [error, status] of [[new BadRequestException('password=secret'), 400], [new UnauthorizedException(), 401],
      [new ForbiddenException(), 403], [new NotFoundException(), 404], [new HttpException('secret', 409), 409], [new HttpException('secret', 429), 429]] as const) {
      expect(mapError(error).status).toBe(status);
      expect(JSON.stringify(mapError(error))).not.toContain('secret');
    }
    expect(mapError({ code: 11000, keyValue: { password: 'secret' } }).status).toBe(409);
    expect(mapError(Object.assign(new Error('mongodb://secret'), { name: 'MongoServerSelectionError' })).status).toBe(503);
    expect(mapError(Object.assign(new Error('secret'), { name: 'CastError' })).status).toBe(400);
    expect(mapError(new Error('secret'))).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });
  it('maps snake_case to camelCase and never serializes the hash', () => {
    const id = new Types.ObjectId();
    const mapped = mapAccount({ _id: id, id, role_id: new Types.ObjectId(), full_name: 'Admin', phone: '+84901234567',
      password_hash: 'secret-hash', status: 'ACTIVE', version: 0, auth_version: 0, created_at: new Date(), updated_at: new Date() });
    expect(mapped.id).toBe(id.toHexString());
    expect(mapped.fullName).toBe('Admin');
    expect(JSON.stringify(mapped)).not.toContain('secret-hash');
    expect(mapped).not.toHaveProperty('_id');
  });
});
