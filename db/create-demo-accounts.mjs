/**
 * db/create-demo-accounts.mjs
 * ---------------------------------------------------------------------------
 * Crea en Neon Auth las 5 cuentas de prueba (Laura, Carlos, Marta, David y
 * Ana) con la contraseña pública APP_CONFIG.demoPassword. Si ya existen, no
 * hace nada. Después se puede cargar db/seed.sql.
 *
 *   node db/create-demo-accounts.mjs
 *
 * Neon Auth comprueba la cabecera Origin: localhost está permitido mientras
 * «Allow localhost» siga activado en la configuración de Neon Auth.
 */
import { APP_CONFIG, DEMO_ACCOUNTS } from '../js/data.js';

const origin = process.env.ORIGIN ?? 'http://localhost:8080';

for (const account of DEMO_ACCOUNTS) {
  const response = await fetch(`${APP_CONFIG.neonAuthUrl}/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email: account.email, password: APP_CONFIG.demoPassword, name: account.displayName }),
  });
  const payload = await response.json().catch(() => null);
  if (response.ok) {
    console.log(`✔ creada ${account.email}`);
    // Se cierra la sesión que abre el registro.
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (cookie) await fetch(`${APP_CONFIG.neonAuthUrl}/sign-out`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: '{}' });
  } else if (payload?.code?.startsWith('USER_ALREADY_EXISTS')) {
    console.log(`· ya existía ${account.email}`);
  } else {
    console.error(`✘ ${account.email}: ${response.status} ${payload?.code ?? ''} ${payload?.message ?? ''}`);
    process.exitCode = 1;
  }
}
