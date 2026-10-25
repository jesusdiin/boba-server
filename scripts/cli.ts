/**
 * CLI de alta para el dueño mientras no exista panel web. Habla con la API
 * admin local (`http://localhost:$PORT`) usando ADMIN_API_KEY.
 *
 *   pnpm cli org:create "Boba & Co."
 *   pnpm cli branch:create <orgId> "Sucursal Centro" [--tz America/Mexico_City]
 *   pnpm cli pair-code <branchId>
 *   pnpm cli devices <branchId>
 *   pnpm cli projections:rebuild [branchId]
 */
import qrcode from 'qrcode-terminal';

const baseUrl =
  process.env.BOBA_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const adminKey = process.env.ADMIN_API_KEY;

async function admin<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  if (!adminKey) throw new Error('Falta ADMIN_API_KEY en el entorno (.env)');
  const res = await fetch(`${baseUrl}/v1/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'org:create': {
      const name = args[0];
      if (!name) throw new Error('Uso: org:create "<nombre>"');
      const org = await admin<{ id: string; name: string }>('POST', '/organizations', {
        name,
      });
      console.log(`Organización creada: ${org.name}\norgId: ${org.id}`);
      return;
    }
    case 'branch:create': {
      const [orgId, name] = args;
      if (!orgId || !name)
        throw new Error('Uso: branch:create <orgId> "<nombre>" [--tz <iana>]');
      const branch = await admin<{ id: string; name: string; timezoneId: string }>(
        'POST',
        `/organizations/${orgId}/branches`,
        { name, timezoneId: flag(args, '--tz') },
      );
      console.log(
        `Sucursal creada: ${branch.name} (${branch.timezoneId})\nbranchId: ${branch.id}`,
      );
      return;
    }
    case 'pair-code': {
      const [branchId] = args;
      if (!branchId) throw new Error('Uso: pair-code <branchId>');
      const { code, expiresAt } = await admin<{ code: string; expiresAt: string }>(
        'POST',
        `/branches/${branchId}/pairing-codes`,
      );
      console.log(
        `Código de emparejamiento: ${code}\nVence: ${new Date(expiresAt).toLocaleString()}`,
      );
      qrcode.generate(code, { small: true });
      return;
    }
    case 'devices': {
      const [branchId] = args;
      if (!branchId) throw new Error('Uso: devices <branchId>');
      const { devices } = await admin<{ devices: unknown[] }>(
        'GET',
        `/branches/${branchId}/devices`,
      );
      console.table(devices);
      return;
    }
    case 'projections:rebuild': {
      const { events } = await admin<{ events: number }>('POST', '/projections/rebuild', {
        branchId: args[0],
      });
      console.log(`Proyecciones reconstruidas desde ${events} eventos`);
      return;
    }
    default:
      console.log(
        'Comandos: org:create | branch:create | pair-code | devices | projections:rebuild',
      );
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
