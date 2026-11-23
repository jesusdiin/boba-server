import { Router } from 'express';
import { z } from 'zod';

import { requireDevice } from '../auth/deviceAuth.js';
import { redeemCoupon } from '../coupons.js';
import type { Db } from '../db.js';
import { HttpError } from '../errors.js';
import { entitlementsOf, planJson } from '../plans.js';
import {
  noopNotifier,
  notifyPlanChanged,
  type BranchNotifier,
} from '../realtime/branchNotifier.js';
import { requireBranchAdmin } from './branch.js';
import { PairingThrottle } from './devices.js';

/// Canje de cupones desde la app (solo el Dueño). Sin `requireActivePlan`:
/// un plan vencido puede reactivarse con un código.
export function couponsRouter(
  db: Db,
  throttle = new PairingThrottle(10, 15 * 60 * 1000),
  notifier: BranchNotifier = noopNotifier,
): Router {
  const router = Router();

  router.post('/redeem', async (req, res) => {
    const device = requireDevice(req.device);
    await requireBranchAdmin(db, device, req.header('x-boba-user'), 'manageOrganization');
    const key = `device:${device.id}`;
    throttle.ensureAllowed(key);
    const { code } = z.object({ code: z.string().trim().min(1).max(64) }).parse(req.body);
    try {
      const { org } = await db.$transaction((tx) =>
        redeemCoupon(tx, device.organizationId, code, new Date()),
      );
      // Los demás equipos del negocio lo reciben al momento.
      await notifyPlanChanged(db, notifier, org.id);
      res.json({ plan: planJson(entitlementsOf(org, new Date()), org.id) });
    } catch (e) {
      // Solo los códigos que no existen cuentan para el freno (adivinar).
      if (e instanceof HttpError && e.code === 'invalid_coupon')
        throttle.recordFailure(key);
      throw e;
    }
  });

  return router;
}
