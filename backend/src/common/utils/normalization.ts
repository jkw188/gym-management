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
