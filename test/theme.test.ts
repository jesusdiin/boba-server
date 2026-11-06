import { describe, expect, it } from 'vitest';

import { envelope, setupTestApp, userCreated } from './helpers.js';

const t = setupTestApp();

const themeSet = (
  branchId: string,
  theme: string,
  setAtUtc: string,
  extra: Record<string, unknown> = {},
) =>
  envelope('branch.theme_set', 'branch', branchId, {
    theme,
    automatic: false,
    setAtUtc,
    userId: null,
    ...extra,
  });

describe('branch.theme_set (tema de la sucursal)', () => {
  it('se acepta, viaja en el pull y el snapshot trae el último', async () => {
    const { token, branchId } = await t.pairedDevice();
    const res = await t.push(token, [
      themeSet(branchId, 'dark', '2026-11-05T15:00:00.000Z'),
      themeSet(branchId, 'minimal', '2026-11-05T16:00:00.000Z', { automatic: true }),
    ]);
    expect(res.body.accepted).toHaveLength(2);

    const snapshot = await t.snapshot(token, branchId);
    expect(snapshot.body.branchTheme).toMatchObject({ theme: 'minimal', automatic: true });
  });

  it('sin cambios de tema, el snapshot trae null', async () => {
    const { token, branchId } = await t.pairedDevice();
    expect((await t.snapshot(token, branchId)).body.branchTheme).toBeNull();
  });

  it('acepta una tipografía conocida y rechaza una desconocida', async () => {
    const { token, branchId } = await t.pairedDevice();
    const at = '2026-11-05T15:00:00.000Z';
    const ok = await t.push(token, [themeSet(branchId, 'minimal', at, { font: 'modern' })]);
    expect(ok.body.accepted).toHaveLength(1);
    const bad = await t.push(token, [themeSet(branchId, 'minimal', at, { font: 'comic' })]);
    expect(bad.body.rejected[0]).toMatchObject({ code: 'invalid_event' });
  });

  it('rechaza un tema desconocido', async () => {
    const { token, branchId } = await t.pairedDevice();
    const res = await t.push(token, [themeSet(branchId, 'neon', '2026-11-05T15:00:00.000Z')]);
    expect(res.body.rejected[0]).toMatchObject({ code: 'invalid_event' });
  });

  it('solo un admin cambia el tema', async () => {
    const { token, branchId } = await t.pairedDevice();
    const cashier = userCreated('cashier');
    const admin = userCreated('admin');
    await t.push(token, [cashier, admin]);

    const denied = await t.push(token, [
      themeSet(branchId, 'dark', '2026-11-05T15:00:00.000Z', { userId: cashier.aggregateId }),
    ]);
    expect(denied.body.rejected[0]).toMatchObject({ code: 'forbidden' });
    const ok = await t.push(token, [
      themeSet(branchId, 'dark', '2026-11-05T15:00:00.000Z', { userId: admin.aggregateId }),
    ]);
    expect(ok.body.accepted).toHaveLength(1);
  });
});
