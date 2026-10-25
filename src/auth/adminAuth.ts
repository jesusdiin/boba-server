import type { RequestHandler } from 'express';

import { unauthorized } from '../errors.js';
import { safeEqual } from '../tokens.js';

/// Endpoints /v1/admin/*: header `X-Admin-Key` igual a ADMIN_API_KEY.
export const adminAuth =
  (adminApiKey: string): RequestHandler =>
  (req, _res, next) => {
    const key = req.header('x-admin-key');
    if (!key || !safeEqual(key, adminApiKey))
      throw unauthorized('Llave de admin inválida');
    next();
  };
