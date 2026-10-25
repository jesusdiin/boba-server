import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

/// Error con status HTTP y código estable para el cliente:
/// la respuesta siempre es `{ error: { code, message } }`.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = (message = 'No autorizado') =>
  new HttpError(401, 'unauthorized', message);
export const notFound = (message = 'No encontrado') =>
  new HttpError(404, 'not_found', message);

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Solicitud inválida',
        issues: err.issues,
      },
    });
    return;
  }
  req.log?.error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal', message: 'Error interno' } });
};
