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
      // 本地 Mailpit：不加密、不登录；真实 SMTP 设 SMTP_SECURE（ssl / starttls）、SMTP_USER、SMTP_PASSWORD，Keycloak 的域模板读同一组变量
      secure: process.env.SMTP_SECURE === "ssl",
      ignoreTLS: !process.env.SMTP_SECURE || process.env.SMTP_SECURE === "none",
      requireTLS: process.env.SMTP_SECURE === "starttls",
      ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? "" } } : {}),
      connectionTimeout: 5000,
    });
    return this.transporter;
  }

  async send(to: string, subject: string, text: string, headers?: Record<string, string>): Promise<void> {
    await this.transport.sendMail({ from: process.env.SMTP_FROM ?? "no-reply@staredu.test", to, subject, text, ...(headers ? { headers } : {}) });
  }
}
