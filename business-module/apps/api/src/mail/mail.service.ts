// 发邮件（Q8：本地只用 Mailpit，SMTP 参数来自环境变量，所有租户共用；换真实 SMTP 只改环境变量）。
import { Injectable } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";

@Injectable()
export class MailService {
  private transporter: Transporter | null = null;

  private get transport(): Transporter {
    this.transporter ??= createTransport({
      host: process.env.SMTP_HOST ?? "localhost",
      port: Number(process.env.SMTP_PORT ?? 1125),
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5000,
    });
    return this.transporter;
  }

  async send(to: string, subject: string, text: string): Promise<void> {
    await this.transport.sendMail({ from: process.env.SMTP_FROM ?? "no-reply@staredu.test", to, subject, text });
  }
}
