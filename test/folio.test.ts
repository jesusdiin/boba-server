import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { folioPrefixFor } from '../src/pairing.js';
import { setupTestApp, userCreated } from './helpers.js';

const t = setupTestApp();

describe('letra de folio por equipo', () => {
  it('cada equipo de la sucursal recibe la siguiente letra y la ve en el pull', async () => {
    const a = (await t.signup()).body as { token: string; folioPrefix: string };
    expect(a.folioPrefix).toBe('A');
    const admin = userCreated('admin');
    await t.push(a.token, [admin]);

    const pair = async (deviceName: string) => {
      const { code } = (await t.branch(a.token, admin.aggregateId).post('/pairing-codes')).body;
      return (await request(t.app).post('/v1/devices/pair').send({ code, deviceName })).body as {
        token: string;
        folioPrefix: string;
      };
    };
    const b = await pair('iPad kiosco');
    expect(b.folioPrefix).toBe('B');

    // Una letra no se reutiliza aunque el equipo se desconecte.
    const list = (await t.branch(a.token, admin.aggregateId).get('/devices')).body.devices as {
      id: string;
      folioPrefix: string;
    }[];
    expect(list.map((d) => d.folioPrefix)).toEqual(['A', 'B']);
    await t.branch(a.token, admin.aggregateId).post(`/devices/${list[1]!.id}/revoke`);
    expect((await pair('iPad 3')).folioPrefix).toBe('C');

    expect((await t.pull(a.token)).body.folioPrefix).toBe('A');
  });

  it('pasa de Z a AA', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(folioPrefixFor)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
    ]);
  });
});
