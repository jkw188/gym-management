// Tầng kiểm thử backend: hộp thư SMTP sandbox chạy ngay trong tiến trình test (US-05 bước 2).
// Spec: "Dev/test dùng SMTP sandbox, test đọc OTP tại hộp thư sandbox", nên test nhận thư thật qua SMTP, không mock hàm gửi.
// Dùng thư viện smtp-server (MIT-0) làm máy chủ nhận thư và mailparser (MIT) để đọc nội dung thư.
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';

export interface SandboxMail {
  authUser: string | undefined; // tài khoản SMTP mà backend đã dùng để đăng nhập
  envelopeFrom: string; // địa chỉ người gửi trong lệnh MAIL FROM
  envelopeTo: string[]; // địa chỉ người nhận trong lệnh RCPT TO (nơi thư thật sự được gửi tới)
  headerTo: string[]; // địa chỉ trong header To của thư
  subject: string;
  text: string; // nội dung thư dạng chữ (nếu thư chỉ có HTML thì là HTML đã bỏ thẻ)
  raw: string; // toàn bộ thư gốc
}

// accept: nhận thư bình thường; reject: nhận xong nội dung rồi báo lỗi 550; slow: chờ lâu rồi mới nhận.
export type SandboxMode = 'accept' | 'reject' | 'slow';

export class SmtpSandbox {
  readonly user = 'us05-sandbox';
  readonly pass = randomBytes(24).toString('base64url');
  readonly from = 'no-reply@gym.test';
  readonly messages: SandboxMail[] = [];
  // Thư đã nhận nội dung nhưng bị từ chối (mode reject), vẫn giữ lại để test kiểm tra OTP không bị lộ ở nơi khác.
  readonly rejected: SandboxMail[] = [];
  mode: SandboxMode = 'accept';
  slowMs = 3000;
  port = 0;
  private server: SMTPServer | undefined;

  // Mở máy chủ SMTP. Lần đầu chọn cổng ngẫu nhiên; mở lại sau stop() thì dùng lại đúng cổng cũ.
  async start(): Promise<void> {
    const server = new SMTPServer({
      secure: false,
      authOptional: false, // bắt buộc đăng nhập bằng SMTP_USER/SMTP_PASS
      allowInsecureAuth: true, // cho đăng nhập không cần TLS vì chỉ chạy trong máy test
      disabledCommands: ['STARTTLS'],
      logger: false,
      onAuth: (auth, _session, callback) => {
        if (auth.username === this.user && auth.password === this.pass) return callback(null, { user: auth.username });
        return callback(new Error('Sai tài khoản SMTP'));
      },
      onData: (stream, session, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', async () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const mail = await this.toMail(raw, session);
          if (this.mode === 'reject') {
            this.rejected.push(mail);
            const error = new Error('Hộp thư sandbox từ chối thư') as Error & { responseCode: number };
            error.responseCode = 550;
            return callback(error);
          }
          if (this.mode === 'slow') await new Promise(resolve => setTimeout(resolve, this.slowMs));
          this.messages.push(mail);
          return callback();
        });
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.port = (server.server.address() as AddressInfo).port;
    this.server = server;
  }

  // Tắt máy chủ: backend gửi thư lúc này sẽ bị lỗi kết nối (giả lập SMTP hỏng).
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  // Biến môi trường để backend kết nối tới hộp thư sandbox (tên biến theo spec US-05).
  env(): Record<string, string> {
    return {
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(this.port),
      SMTP_SECURE: 'false',
      SMTP_USER: this.user,
      SMTP_PASS: this.pass,
      SMTP_FROM: this.from,
    };
  }

  clear(): void {
    this.messages.length = 0;
    this.rejected.length = 0;
    this.mode = 'accept';
  }

  // Chờ tới khi hộp thư có đủ `count` thư (thư gửi sau phản hồi 202 nên có thể đến trễ một chút).
  async waitForMessages(count: number, timeoutMs = 5000): Promise<SandboxMail[]> {
    return this.waitFor(() => this.messages.length >= count, timeoutMs, () => `Chờ ${count} thư nhưng chỉ có ${this.messages.length}`)
      .then(() => this.messages);
  }

  async waitForRejected(count: number, timeoutMs = 5000): Promise<SandboxMail[]> {
    return this.waitFor(() => this.rejected.length >= count, timeoutMs, () => `Chờ ${count} thư bị từ chối nhưng chỉ có ${this.rejected.length}`)
      .then(() => this.rejected);
  }

  private async waitFor(done: () => boolean, timeoutMs: number, message: () => string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(message());
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private async toMail(raw: string, session: { user?: unknown; envelope: { mailFrom: false | { address: string }; rcptTo: { address: string }[] } }) {
    const parsed = await simpleParser(raw);
    const headerTo = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [])
      .flatMap(group => group.value.map(address => address.address ?? ''));
    return {
      authUser: typeof session.user === 'string' ? session.user : undefined,
      envelopeFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
      envelopeTo: session.envelope.rcptTo.map(recipient => recipient.address),
      headerTo,
      subject: parsed.subject ?? '',
      text: parsed.text ?? (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : ''),
      raw,
    };
  }
}

// Lấy OTP 6 chữ số trong nội dung thư. Trả về undefined nếu không có hoặc có nhiều mã khác nhau.
export function extractOtp(mail: SandboxMail): string | undefined {
  const codes = new Set(mail.text.match(/(?<!\d)\d{6}(?!\d)/g) ?? []);
  return codes.size === 1 ? [...codes][0] : undefined;
}
