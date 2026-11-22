import nodemailer from 'nodemailer';
import type { Logger } from 'pino';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/// Envío de correos (códigos de la cuenta del Dueño).
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
}

/// SMTP genérico (Resend, Brevo, SES, Zoho, el correo del dominio…).
export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(private readonly config: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: config.user ? { user: config.user, pass: config.pass ?? '' } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.config.from, ...message });
  }
}

/// Sin SMTP (desarrollo): el correo va al log, código incluido.
export class ConsoleMailer implements Mailer {
  constructor(private readonly logger: Logger) {}

  async send(message: MailMessage): Promise<void> {
    this.logger.warn({ to: message.to, subject: message.subject }, message.text);
  }
}

/// Guarda lo enviado (pruebas).
export class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  /// Último código de 6 dígitos enviado a [to].
  lastCode(to: string): string | undefined {
    const msg = [...this.sent].reverse().find((m) => m.to === to);
    return msg?.text.match(/\b(\d{6})\b/)?.[1];
  }
}

/// "Tu código es 123456" (texto y HTML sencillo, sin enlaces).
export function codeEmail(
  to: string,
  { code, purpose, businessName }: { code: string; purpose: 'link_email' | 'reset_pin'; businessName: string },
): MailMessage {
  const what =
    purpose === 'reset_pin'
      ? `para cambiar el PIN del Dueño de ${businessName}`
      : `para verificar tu correo como Dueño de ${businessName}`;
  const text =
    `Tu código de Boba POS es ${code}.\n\n` +
    `Úsalo ${what}. Vence en 10 minutos.\n\n` +
    'Si no lo pediste, ignora este correo.';
  const html =
    `<p>Tu código de Boba POS es</p>` +
    `<p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p>` +
    `<p>Úsalo ${escapeHtml(what)}. Vence en 10 minutos.</p>` +
    '<p style="color:#777">Si no lo pediste, ignora este correo.</p>';
  return { to, subject: `Tu código de Boba POS: ${code}`, text, html };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
