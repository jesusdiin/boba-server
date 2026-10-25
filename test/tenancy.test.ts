import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { setupTestApp, userUpdatedEvent } from './helpers.js';

const t = setupTestApp();

describe('aislamiento multi-tenant', () => {
  it('un dispositivo solo ve los eventos de su sucursal', async () => {
    const a = await t.pairedDevice();
    const sameOrgOtherBranch = await t.pairedDevice({ orgId: a.orgId });
    const otherOrg = await t.pairedDevice();

    await t.push(a.token, [userUpdatedEvent()]);
    await t.push(sameOrgOtherBranch.token, [userUpdatedEvent()]);
    await t.push(otherOrg.token, [userUpdatedEvent()]);

    for (const device of [a, sameOrgOtherBranch, otherOrg]) {
      const { events } = (await t.pull(device.token)).body;
      expect(events).toHaveLength(1);
      expect(events[0].deviceId).toBe(device.deviceId);
    }
  });

  it('org y sucursal salen del token, aunque el body diga otra cosa', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairedDevice();
    await request(t.app)
      .post('/v1/sync/push')
      .set('authorization', `Bearer ${a.token}`)
      .send({
        branchId: b.branchId,
        organizationId: b.orgId,
        events: [userUpdatedEvent()],
      });

    const stored = await t.db.event.findFirstOrThrow();
    expect(stored.branchId).toBe(a.branchId);
    expect(stored.organizationId).toBe(a.orgId);
    expect((await t.pull(b.token)).body.events).toEqual([]);
  });

  it('un eventId de otra sucursal se rechaza sin revelarla', async () => {
    const a = await t.pairedDevice();
    const b = await t.pairedDevice();
    const event = userUpdatedEvent();
    await t.push(a.token, [event]);

    const res = await t.push(b.token, [event]);
    expect(res.body.rejected).toEqual([
      expect.objectContaining({ eventId: event.eventId, code: 'conflict_other_branch' }),
    ]);
    expect((await t.pull(b.token)).body.events).toEqual([]);
  });

  it('un token revocado deja de funcionar', async () => {
    const a = await t.pairedDevice();
    await t.admin().post(`/devices/${a.deviceId}/revoke`);
    expect((await t.pull(a.token)).status).toBe(401);

    const { devices } = (await t.admin().get(`/branches/${a.branchId}/devices`)).body;
    expect(devices[0].revokedAt).not.toBeNull();
  });
});
