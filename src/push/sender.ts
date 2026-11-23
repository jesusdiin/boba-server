import { readFileSync } from 'node:fs';

import { cert, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

export interface PushMessage {
  title: string;
  body: string;
}

export interface PushResult {
  sent: number;
  failed: number;
  /// Instalaciones que FCM ya no reconoce (app desinstalada): se borran.
  invalidTokens: string[];
}

/// Envía notificaciones a un conjunto de instalaciones.
export interface PushSender {
  send(tokens: string[], message: PushMessage): Promise<PushResult>;
}

/// FCM acepta hasta 500 instalaciones por envío. Se envía al id de
/// instalación de Firebase (FID), que reemplaza al token de registro.
const BATCH = 500;

/// Errores de FCM que significan "este token ya no sirve".
const INVALID = new Set([
  'messaging/installation-id-not-registered',
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/// Firebase Cloud Messaging con una cuenta de servicio.
export class FcmSender implements PushSender {
  constructor(private readonly messaging: Messaging) {}

  /// Desde el JSON de la cuenta de servicio (Firebase → Cuentas de servicio).
  static fromServiceAccountFile(path: string): FcmSender {
    const account = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    const app: App = initializeApp({ credential: cert(account) }, 'boba-push');
    return new FcmSender(getMessaging(app));
  }

  async send(tokens: string[], { title, body }: PushMessage): Promise<PushResult> {
    const result: PushResult = { sent: 0, failed: 0, invalidTokens: [] };
    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      const res = await this.messaging.sendEachForMulticast({
        fids: batch,
        notification: { title, body },
        android: { priority: 'high', notification: { channelId: 'avisos' } },
      });
      result.sent += res.successCount;
      result.failed += res.failureCount;
      res.responses.forEach((r, j) => {
        if (!r.success && r.error && INVALID.has(r.error.code)) {
          result.invalidTokens.push(batch[j]!);
        }
      });
    }
    return result;
  }
}

/// Para pruebas: registra lo enviado; [invalid] simula tokens caducos.
export class FakePushSender implements PushSender {
  readonly sends: { tokens: string[]; message: PushMessage }[] = [];
  constructor(readonly invalid = new Set<string>()) {}

  send(tokens: string[], message: PushMessage): Promise<PushResult> {
    this.sends.push({ tokens, message });
    const bad = tokens.filter((t) => this.invalid.has(t));
    return Promise.resolve({
      sent: tokens.length - bad.length,
      failed: bad.length,
      invalidTokens: bad,
    });
  }
}
