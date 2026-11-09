import { isEmail } from 'class-validator';
import { invalidField } from '../errors/application-error';

export function normalizePhone(value: string): string {
  if (typeof value !== 'string' || !/^[+\d\s.()\-]+$/.test(value)) invalidField('phone', 'Số điện thoại không hợp lệ');
  // Parentheses must be balanced and non-nested; punctuation is only a separator.
  let depth = 0;
  for (const char of value) {
    if (char === '(' && ++depth > 1) invalidField('phone', 'Số điện thoại không hợp lệ');
    if (char === ')' && --depth < 0) invalidField('phone', 'Số điện thoại không hợp lệ');
  }
  if (depth !== 0 || /\(\s*\)/.test(value)) invalidField('phone', 'Số điện thoại không hợp lệ');
  let phone = value.replace(/[\s.()\-]/g, '');
  if (/^0\d{9,10}$/.test(phone)) phone = `+84${phone.slice(1)}`;
  else if (/^84\d{9,10}$/.test(phone)) phone = `+${phone}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) invalidField('phone', 'Số điện thoại không hợp lệ');
  return phone;
}

export function normalizeEmail(value?: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalidField('email', 'Email không hợp lệ');
  const email = value.trim().toLowerCase();
  if (!email) return undefined;
  if (email.length > 190 || !isEmail(email)) invalidField('email', 'Email không hợp lệ');
  return email;
}

export function normalizeFullName(value: string): string {
  if (typeof value !== 'string') invalidField('fullName', 'Họ tên phải từ 2 đến 120 ký tự');
  const name = value.trim().replace(/\s+/g, ' ');
  if (Array.from(name).length < 2 || Array.from(name).length > 120) invalidField('fullName', 'Họ tên phải từ 2 đến 120 ký tự');
  return name;
}

export function validateObjectId(value: string): string {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) invalidField('id', 'ID không hợp lệ');
  return value;
}

// Ngày hôm nay theo giờ Việt Nam, dạng YYYY-MM-DD.
export function todayInVietnam(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now);
}

// Ngày sinh YYYY-MM-DD phải là ngày có thật và không sau hôm nay (giờ Việt Nam). Dùng chung cho US-04 và US-09.
export function normalizeBirthDate(value: string | null): string | null {
  if (value === null) return null;
  const invalid = () => invalidField('birthDate', 'Ngày sinh phải là ngày hợp lệ dạng YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid();
  if (value > todayInVietnam()) invalidField('birthDate', 'Ngày sinh không được sau ngày hiện tại');
  return value;
}

// Địa chỉ bỏ khoảng trắng hai đầu; rỗng coi như không có; tối đa 255 ký tự. Dùng chung cho US-04 và US-09.
export function normalizeAddress(value: string | null): string | null {
  if (value === null) return null;
  const address = value.trim();
  if (!address) return null;
  if (address.length > 255) invalidField('address', 'Địa chỉ tối đa 255 ký tự');
  return address;
}
