// Tầng hạ tầng (SMTP adapter): gửi thư chứa OTP quên mật khẩu qua SMTP bằng nodemailer (US-05 bước 2).
// Chỉ lo việc gửi thư; quyết định gửi cho ai, lúc nào nằm ở PasswordResetService.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, Transporter } from 'nodemailer';
import { SmtpConfiguration } from '../../config/auth.configuration';

@Injectable()
export class PasswordResetMailer {
  private transporter: Transporter | undefined;

  constructor(private readonly config: ConfigService) {}

  // US-05-TC14: không bao giờ ném lỗi ra ngoài, vì thư được gửi SAU khi đã trả 202, không còn ai nhận lỗi.
  // Lỗi chỉ ghi log mã lỗi an toàn: không ghi OTP, email, nội dung thư hay mật khẩu SMTP (US-05-TC05).
  async sendResetCode(email: string, otp: string): Promise<void> {
    try {
      await this.getTransporter().sendMail({
        from: this.config.getOrThrow<SmtpConfiguration>('smtp').from,
        to: email,
        subject: 'Mã đặt lại mật khẩu Gym Management',
        // Mục 2 spec: thư chỉ nêu mã, hạn 10 phút và hướng dẫn bỏ qua khi không yêu cầu.
        text: [
          `Mã xác thực đặt lại mật khẩu của bạn là: ${otp}`,
          'Mã có hiệu lực trong 10 phút.',
          'Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua thư này.',
        ].join('\n'),
      });
    } catch (error) {
      // code (ví dụ ECONNECTION) và responseCode (ví dụ 550) chỉ nói loại lỗi, không chứa dữ liệu người dùng.
      const details = error as { code?: unknown; responseCode?: unknown };
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(), code: 'PASSWORD_RESET_EMAIL_FAILED',
        smtpError: typeof details.code === 'string' ? details.code : undefined,
        smtpResponseCode: typeof details.responseCode === 'number' ? details.responseCode : undefined,
      }));
    }
  }

  // Tạo kết nối SMTP lần đầu cần dùng, các lần sau dùng lại.
  private getTransporter(): Transporter {
    if (!this.transporter) {
      const smtp = this.config.getOrThrow<SmtpConfiguration>('smtp');
      this.transporter = createTransport({
        host: smtp.host, port: smtp.port, secure: smtp.secure, auth: { user: smtp.user, pass: smtp.pass },
        // Production bắt buộc mã hóa đường truyền (STARTTLS) khi không dùng cổng TLS ngay từ đầu.
        requireTLS: !smtp.secure && this.config.get('nodeEnv') === 'production',
        // Máy chủ thư treo thì bỏ sau vài giây, không giữ kết nối mãi.
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      });
    }
    return this.transporter;
  }
}
