import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { ENV, type Env } from '../config/env.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Envío de correo por SMTP real. En desarrollo se usa Mailpit (perfil `mail`
 * de docker compose). Si no hay SMTP configurado fuera de producción, el
 * correo NO se envía y se registra una advertencia con el enlace, para que el
 * desarrollador pueda continuar; en producción la API no arranca sin SMTP.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private transport: Transporter | null;

  constructor(@Inject(ENV) private readonly env: Env) {
    if (!env.SMTP_HOST) {
      if (env.isProd) throw new Error('SMTP_HOST es obligatorio en producción');
      this.transport = null;
    } else {
      this.transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE === 'true',
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      });
    }
  }

  /** Permite a las pruebas inyectar un transporte (p. ej. jsonTransport). */
  useTransport(t: Transporter) {
    this.transport = t;
  }

  async send(msg: MailMessage): Promise<boolean> {
    if (!this.transport) {
      this.log.warn(`[SMTP no configurado] correo NO enviado a ${msg.to}: "${msg.subject}"\n${msg.text}`);
      return false;
    }
    await this.transport.sendMail({ from: this.env.MAIL_FROM, ...msg });
    return true;
  }
}
