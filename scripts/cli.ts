/**
 * CLI de alta para el dueño mientras no exista panel web. Habla con la API
 * admin local (`http://localhost:$PORT`) usando ADMIN_API_KEY.
 *
 *   pnpm cli org:create "Boba & Co."
 *   pnpm cli branch:create <orgId> "Sucursal Centro" [--tz America/Mexico_City]
 *   pnpm cli pair-code <branchId>
 *   pnpm cli devices <branchId>
 *   pnpm cli projections:rebuild [branchId]
 *   pnpm cli org:show <orgId>
 *   pnpm cli users:promote-admins [orgId]   (admins → Dueño; después de actualizar la app)
 *   pnpm cli org:plan <orgId> <pro|max> <trialing|active|past_due|canceled> [YYYY-MM-DD|none]
 */
import qrcode from 'qrcode-terminal';

const baseUrl =
  process.env.BOBA_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const adminKey = process.env.ADMIN_API_KEY;

async function admin<T>(
  method: 'GET' | 'POST' | 'PATCH',
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

interface PlanJson {
  plan: string;
  status: string;
  state: string;
  periodEnd: string | null;
  graceUntil: string | null;
  limits: { branches: number; devices: number };
}

interface OrgSummary {
  name: string;
  billingSource: string;
  plan: PlanJson;
  usage: { branches: number; devices: number };
  branches: { id: string; name: string }[];
}

function printPlan(label: string, p: PlanJson): void {
  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString() : 'sin vencimiento';
  console.log(
    `${label}: plan ${p.plan} · ${p.status} (${p.state})\n` +
      `Periodo hasta: ${date(p.periodEnd)} · gracia hasta: ${date(p.graceUntil)}`,
  );
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
    case 'users:promote-admins': {
      const [orgId] = args;
      const { promoted } = await admin<{ promoted: number }>(
        'POST',
        '/users/promote-admins',
        orgId ? { organizationId: orgId } : {},
      );
      console.log(`${promoted} admin(s) ahora son Dueño.`);
      return;
    }
    case 'org:show': {
      const [orgId] = args;
      if (!orgId) throw new Error('Uso: org:show <orgId>');
      const org = await admin<OrgSummary>('GET', `/organizations/${orgId}`);
      printPlan(org.name, org.plan);
      console.log(`Cobro: ${org.billingSource === 'store' ? 'tienda (RevenueCat)' : 'manual'}`);
      console.log(
        `Uso: ${org.usage.devices}/${org.plan.limits.devices} equipos · ` +
          `${org.usage.branches}/${org.plan.limits.branches} sucursales`,
      );
      console.table(org.branches);
      return;
    }
    case 'org:plan': {
      const [orgId, plan, status, end] = args;
      if (!orgId || !plan || !status) {
        throw new Error(
          'Uso: org:plan <orgId> <pro|max> <trialing|active|past_due|canceled> [YYYY-MM-DD|none]',
        );
      }
      // Fin del periodo a medianoche de la Ciudad de México.
      const currentPeriodEnd =
        end === undefined ? undefined : end === 'none' ? null : `${end}T00:00:00-06:00`;
      const res = await admin<{ plan: PlanJson }>(
        'PATCH',
        `/organizations/${orgId}/plan`,
        {
          plan,
          subscriptionStatus: status,
          currentPeriodEnd,
        },
      );
      printPlan(orgId, res.plan);
      return;
    }
    default:
      console.log(
        'Comandos: org:create | org:show | org:plan | branch:create | pair-code | devices | ' +
          'projections:rebuild',
      );
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
