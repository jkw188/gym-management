import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { mapUserResponse } from '../src/modules/users/account.mapper';
import { CreateUserDto, ListUsersDto, UpdateUserDto } from '../src/modules/users/users.dto';
import { UsersRepository } from '../src/modules/users/users.repository';
import { UsersService } from '../src/modules/users/users.service';
import { PasswordService } from '../src/common/security/password.service';

const create = { fullName: 'Test User', phone: '0901234567', password: '  password 123  ', roleCode: 'MEMBER' };
const options = { whitelist: true, forbidNonWhitelisted: true };

describe('US-06 DTOs and public response', () => {
  it('accepts Unicode passwords and optional email without implicit coercion', async () => {
    expect(await validate(plainToInstance(CreateUserDto, { ...create, password: '😀'.repeat(128) }), options)).toEqual([]);
    expect(await validate(plainToInstance(UpdateUserDto, { version: 0, email: null }), options)).toEqual([]);
    for (const body of [{ ...create, password: 123 }, { ...create, email: null }, { ...create, roleCode: 'PT' }, { ...create, version: 0 }]) {
      expect((await validate(plainToInstance(CreateUserDto, body), options)).length).toBeGreaterThan(0);
    }
  });

  it.each([
    { fullName: 'New Name' }, { version: '0', fullName: 'New Name' }, { version: -1, email: null },
    { version: 0, phone: null }, { version: 0, fullName: null }, { version: 0, roleCode: 'ADMIN' },
    { version: 0, status: 'LOCKED' }, { version: 0, password: 'password 123' },
  ])('rejects invalid update input %j', async body => {
    expect((await validate(plainToInstance(UpdateUserDto, body), options)).length).toBeGreaterThan(0);
  });

  it('only transforms valid decimal paging queries', async () => {
    const dto = plainToInstance(ListUsersDto, { page: '2', limit: '50' });
    expect(await validate(dto, options)).toEqual([]);
    expect(dto).toMatchObject({ page: 2, limit: 50 });
    for (const query of [{ page: '0' }, { page: '1e2' }, { limit: '101' }, { page: ['1', '2'] }, { q: 'a'.repeat(121) }, { roleCode: 'PT' }]) {
      expect((await validate(plainToInstance(ListUsersDto, query), options)).length).toBeGreaterThan(0);
    }
  });

  it('allowlists HTTP fields independently of the internal Auth mapper', () => {
    const id = new Types.ObjectId();
    const role = { _id: id, id, code: 'ADMIN' as const, name: 'Admin', created_at: new Date(), updated_at: new Date() };
    const account = { _id: id, id, role_id: id, full_name: 'Test User', phone: '+84901234567', password_hash: 'secret',
      status: 'ACTIVE' as const, version: 0, auth_version: 10, created_at: new Date(), updated_at: new Date() };
    expect(Object.keys(mapUserResponse(account, role)).sort()).toEqual(['createdAt', 'fullName', 'id', 'phone', 'roleCode', 'roleName', 'status', 'updatedAt', 'version']);
  });
});

describe('US-06 optimistic update failure classification', () => {
  it.each([false, true])('distinguishes lost account from stale version after a failed atomic write (exists=%s)', async exists => {
    const id = new Types.ObjectId();
    const account = { _id: id, id, role_id: id, full_name: 'Old Name', phone: '+84901234567', version: 0 };
    const repository = {
      findAccountById: jest.fn().mockResolvedValueOnce(account).mockResolvedValueOnce(exists ? account : null),
      findRoleById: jest.fn().mockResolvedValue({ id, code: 'ADMIN', name: 'Admin' }),
      updateAccount: jest.fn().mockResolvedValue(null),
    };
    const service = new UsersService(repository as unknown as UsersRepository, new PasswordService());
    await expect(service.update(id.toHexString(), { fullName: 'New Name', version: 0 })).rejects.toMatchObject({
      status: exists ? 409 : 404, code: exists ? 'VERSION_CONFLICT' : 'USER_NOT_FOUND',
    });
    expect(repository.updateAccount).toHaveBeenCalledWith(id.toHexString(), 0, { fullName: 'New Name' });
  });
});
