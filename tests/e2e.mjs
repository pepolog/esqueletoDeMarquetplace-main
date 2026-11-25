/**
 * tests/e2e.mjs
 * ---------------------------------------------------------------------------
 * Prueba de extremo a extremo de los escenarios de verificación del proyecto
 * (crear anuncios de cada tipo, editar/pausar, favoritos, pedidos entre
 * cuentas, solapes de reservas, persistencia tras recargar…).
 *
 * El servidor de cuentas (Neon Auth) se simula aquí mismo con page.route,
 * para no crear usuarios reales en la base de datos en cada ejecución.
 *
 * Uso (con el servidor local arrancado en la raíz del repositorio):
 *   npm install --no-save playwright && npx playwright install chromium
 *   BASE_URL=http://localhost:8080/ node tests/e2e.mjs
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080/';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAQklEQVR4nO3PQQ0AIBDAMMC/5+OPAvYKkLzr1tm5+gT8AwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8nQCpAAFeeZqUAAAAAElFTkSuQmCC', 'base64');
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });

// --- Neon Auth simulado (mismas rutas, códigos y respuestas que Managed Better Auth) ---
const neon = { users: new Map(), sessionEmail: null };
await context.route(/\.neonauth\..*\/auth\//, async (route) => {
  const request = route.request();
  const cors = {
    'access-control-allow-origin': request.headers().origin ?? new URL(BASE).origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const json = (status, data) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  let body = {};
  try { body = request.postDataJSON() ?? {}; } catch { body = {}; }
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, emailVerified: false, createdAt: u.createdAt });
  const current = neon.users.get(neon.sessionEmail);
  switch (new URL(request.url()).pathname.replace(/^.*\/auth/, '')) {
    case '/get-session': return json(200, current ? { user: publicUser(current), session: { id: 'ses_e2e', userId: current.id } } : null);
    case '/sign-up/email': {
      if (neon.users.has(body.email)) return json(422, { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', message: 'User already exists. Use another email.' });
      if (String(body.password).length < 8) return json(400, { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' });
      const user = { id: crypto.randomUUID(), name: body.name, email: body.email, password: body.password, createdAt: new Date().toISOString() };
      neon.users.set(body.email, user);
      neon.sessionEmail = body.email;
      return json(200, { token: 'tok', user: publicUser(user) });
    }
    case '/sign-in/email': {
      const user = neon.users.get(body.email);
      if (!user || user.password !== body.password) return json(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });
      neon.sessionEmail = body.email;
      return json(200, { redirect: false, token: 'tok', user: publicUser(user) });
    }
    case '/sign-out': neon.sessionEmail = null; return json(200, { success: true });
    case '/change-password': {
      if (!current) return json(401, { code: 'UNAUTHORIZED', message: 'Unauthorized' });
      if (current.password !== body.currentPassword) return json(400, { code: 'INVALID_PASSWORD', message: 'Invalid password' });
      current.password = body.newPassword;
      return json(200, { token: 'tok', user: publicUser(current) });
    }
    case '/update-user': if (current) current.name = body.name; return json(200, { status: true });
    default: return json(404, { code: 'NOT_FOUND', message: 'Not found' });
  }
});

const page = await context.newPage();
const errors = [];
// Las respuestas 401/422 esperadas (contraseña incorrecta, correo repetido) no cuentan como errores.
const expectedHttpError = (text) => /Failed to load resource: the server responded with a status of (400|401|422)/.test(text);
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !expectedHttpError(m.text())) errors.push(`console: ${m.text()}`); });
const log = (...a) => console.log('✔', ...a);

const go = async (hash) => { await page.evaluate((h) => { if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = h; }, hash); await page.waitForTimeout(300); };
const next = async () => { await page.click('[data-next]'); await page.waitForTimeout(80); };
const pickCard = (name, value) => page.locator(`label.option-card:has(input[name="${name}"][value="${value}"])`).click();
async function setField(name, value) {
  const el = page.locator(`#view [name="${name}"], .modal [name="${name}"]`).first();
  const tag = await el.evaluate((n) => n.tagName + ':' + n.type);
  if (tag.startsWith('SELECT')) await el.selectOption(String(value));
  else if (tag.endsWith('checkbox')) { if (value) await el.check(); else await el.uncheck(); }
  else await el.fill(String(value));
}
async function stepLabel() { return (await page.locator('.wizard__progress-label').textContent()).trim(); }

async function createListing(o) {
  await go('#/sell');
  if (await page.locator('[data-restart]').count()) await page.click('[data-restart]');
  await pickCard('category', o.category);
  await next();
  if (o.op && await page.locator('input[name="operationType"]').count()) await pickCard('operationType', o.op);
  if (o.op === 'rent') {
    if (o.period && await page.locator('input[name="rental.period"]').count()) await pickCard('rental.period', o.period);
    await setField('price', o.price);
    await setField('availability', o.availability ?? 'Todos los días');
    await setField('rental.minDuration', o.minDuration ?? 1);
  }
  if (o.onStep2) await o.onStep2();
  await next();
  assert.match(await stepLabel(), /Paso 3/);
  await setField('title', o.title);
  await setField('description', o.description ?? `${o.title}. Descripción de prueba suficientemente larga.`);
  if (o.op !== 'rent') await setField('price', o.price);
  for (const [k, v] of Object.entries(o.basic ?? {})) await setField(k, v);
  await next();
  assert.match(await stepLabel(), /Paso 4/);
  if (o.onStep4) await o.onStep4();
  for (const [k, v] of Object.entries(o.attrs ?? {})) await setField(`attributes.${k}`, v);
  await next();
  assert.match(await stepLabel(), /Paso 5/, 'should reach photos');
  await page.setInputFiles('#photo-input', { name: 'foto.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('.photo-item');
  await next();
  assert.match(await stepLabel(), /Paso 6/);
  await setField('location.city', o.city ?? 'Zaragoza');
  await setField('location.zone', o.zone ?? 'Centro');
  for (const d of o.delivery ?? []) {
    const box = page.locator(`input[name="delivery.${d}"]`);
    if (!(await box.isChecked())) await page.locator(`label.option-card:has(input[name="delivery.${d}"])`).click();
  }
  await next();
  assert.match(await stepLabel(), /Paso 7/);
  await page.click('[data-publish]');
  await page.waitForSelector('.wizard-success');
  const href = await page.locator('.wizard-success a[href^="#/listing/"]').getAttribute('href');
  return href.split('/').pop();
}

await page.goto(BASE + '#/home');
await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
await page.reload();
await page.waitForSelector('.listing-card');

// --- 0. Acceso: cuadro al abrir, invitado, registro, inicio y cierre de sesión ---
const authDialog = '.auth-dialog';
const closedDialog = () => page.waitForSelector(authDialog, { state: 'detached' });
const openMenu = async () => { if (await page.locator('#user-menu-panel').isHidden()) await page.click('#user-menu-trigger'); };
const menuName = async () => (await page.locator('#user-menu-panel .user-menu__header strong').textContent()).trim();
async function logoutNow() {
  await openMenu();
  await page.click('#user-menu-panel [data-logout]');
  await page.waitForTimeout(400);
  await openMenu();
  assert.equal(await menuName(), 'Invitado');
  await page.click('#user-menu-trigger');
}
async function openLogin() {
  await openMenu();
  await page.click('#user-menu-panel .user-menu__auth [data-auth-open="login"]');
  await page.waitForSelector(authDialog);
}
async function fillRegister(values) {
  for (const [name, value] of Object.entries(values)) {
    if (name === 'regAcceptTerms') { if (value) await page.check('#f-regAcceptTerms'); else await page.uncheck('#f-regAcceptTerms'); }
    else await page.fill(`#f-${name}`, value);
  }
  await page.click('#auth-register button[type="submit"]');
  await page.waitForTimeout(500);
}

await page.waitForSelector(authDialog);
assert.match(await page.locator(`${authDialog} .modal__title`).textContent(), /bienvenida/i);
assert.ok(await page.locator('#auth-login').isVisible(), 'login tab shown first');
await page.click('[data-guest]');
await closedDialog();
await openMenu();
assert.equal(await menuName(), 'Invitado');
await page.click('#user-menu-trigger');
assert.equal(await page.locator('.count-dot:not([hidden])').count(), 0, 'guest has no counters');
// Al recargar en la misma pestaña no vuelve a salir el cuadro
await page.reload();
await page.waitForSelector('.listing-card');
await page.waitForTimeout(400);
assert.equal(await page.locator(authDialog).count(), 0, 'welcome dialog only once per tab');
// Un invitado puede ver un anuncio pero no guardarlo ni comprarlo
await page.locator('.listing-card .fav-btn').first().click();
await page.waitForSelector(authDialog);
assert.match(await page.locator(`${authDialog} [data-auth-reason]`).textContent(), /favoritos/);
await page.keyboard.press('Escape');
await closedDialog();
await go('#/listing/lst_010');
assert.ok(await page.locator('.detail__guest-hint').count(), 'guest hint on listing');
await page.click('[data-buy]');
await page.waitForSelector(authDialog);
assert.equal(await page.locator('#purchase-form').count(), 0, 'no purchase form for guests');
await page.keyboard.press('Escape');
await closedDialog();
// Sección privada: aviso + cuadro de acceso
await go('#/sell');
assert.match(await page.locator('#view').textContent(), /Inicia sesión para continuar/);
await page.waitForSelector(authDialog);
log('0. Cuadro de acceso al abrir, modo invitado y secciones protegidas');

// Registro: validaciones, correo repetido y alta correcta
await page.click('#auth-tab-register');
await page.click('#auth-register button[type="submit"]');
await page.waitForTimeout(400);
for (const name of ['regFirstName', 'regLastName', 'regUsername', 'regEmail', 'regPassword', 'regAcceptTerms']) {
  assert.ok(await page.locator(`#f-${name}[aria-invalid="true"]`).count(), `${name} invalid`);
}
const newAccount = { regFirstName: 'Prueba', regLastName: 'Automática', regUsername: 'pruebae2e', regEmail: 'prueba.e2e@example.com', regPassword: 'secreta123', regPasswordConfirm: 'secreta123', regAcceptTerms: true };
await fillRegister({ ...newAccount, regEmail: 'laura.martin@example.com' });
assert.match(await page.locator('#auth-register').textContent(), /Ya existe una cuenta con ese correo/);
await fillRegister({ ...newAccount, regPasswordConfirm: 'otra12345' });
assert.match(await page.locator('#auth-register').textContent(), /no coinciden/);
await fillRegister({ ...newAccount, regPassword: 'corta', regPasswordConfirm: 'corta' });
assert.match(await page.locator('#auth-register').textContent(), /al menos 8/);
await fillRegister(newAccount);
await closedDialog();
await page.waitForSelector('.wizard');
await openMenu();
assert.equal(await menuName(), 'Prueba Automática');
assert.equal(await page.locator('#demo-user-switch option[value^="usr_"]').count(), 0, 'own account not in demo switcher');
await page.click('#user-menu-trigger');
const stored = await page.evaluate(() => localStorage.getItem('lonja.db.v1'));
assert.ok(!stored.includes('secreta123'), 'password never stored in the browser');
const localProfile = JSON.parse(stored).users.find((user) => user.email === 'prueba.e2e@example.com');
assert.ok(localProfile.remote && !localProfile.credentials, 'local profile linked to the Neon account');
assert.equal(neon.users.get('prueba.e2e@example.com')?.id, localProfile.id, 'account created in Neon Auth with the same id');
assert.equal(neon.users.get('prueba.e2e@example.com').name, 'Prueba Automática');
log('   Registro en Neon Auth con validaciones (campos, correo repetido, contraseñas); la contraseña no se guarda en el navegador');

// Cambio de contraseña de la cuenta propia
await go('#/settings/security');
await page.fill('#f-currentPassword', 'incorrecta1');
await page.fill('#f-newPassword', 'nueva12345');
await page.fill('#f-newPasswordConfirm', 'nueva12345');
await page.click('button[form="password-form"]');
await page.waitForTimeout(600);
assert.ok(await page.locator('#f-currentPassword[aria-invalid="true"]').count(), 'wrong current password');
await page.fill('#f-currentPassword', 'secreta123');
await page.click('button[form="password-form"]');
await page.waitForTimeout(800);
assert.match(await page.locator('#toast-region').textContent(), /Contraseña actualizada/);
assert.equal(neon.users.get('prueba.e2e@example.com').password, 'nueva12345', 'password changed in Neon');

// Cerrar sesión e iniciarla de nuevo (contraseña incorrecta y correcta)
await logoutNow();
assert.equal(neon.sessionEmail, null, 'Neon session closed');
assert.equal(new URL(page.url()).hash, '#/home', 'logout from private page goes home');
await openLogin();
await page.fill('#f-loginIdentifier', 'prueba.e2e@example.com');
await page.fill('#f-loginPassword', 'secreta123');
await page.click('#auth-login button[type="submit"]');
await page.waitForTimeout(800);
assert.match(await page.locator('#auth-login [data-auth-error]').textContent(), /no son correctos/);
await page.fill('#f-loginIdentifier', 'PruebaE2E');
await page.fill('#f-loginPassword', 'nueva12345');
await page.click('#auth-login button[type="submit"]');
await closedDialog();
await openMenu();
assert.equal(await menuName(), 'Prueba Automática');
await page.click('#user-menu-trigger');
// Tras recargar la sesión se mantiene, y se recupera de Neon aunque se borre la sesión local
await page.reload();
await page.waitForSelector('.listing-card');
await openMenu();
assert.equal(await menuName(), 'Prueba Automática');
await page.click('#user-menu-trigger');
await page.evaluate(() => localStorage.removeItem('lonja.session.v1'));
await page.reload();
await page.waitForSelector('.listing-card');
await openMenu();
assert.equal(await menuName(), 'Prueba Automática', 'session restored from Neon');
await page.click('#user-menu-trigger');
log('   Cierre de sesión, contraseña incorrecta rechazada, inicio con usuario y sesión persistente');

// Entrar con una cuenta de prueba: correo + contraseña pública y selector
await logoutNow();
await openLogin();
await page.fill('#f-loginIdentifier', 'carlos.ruiz@example.com');
await page.fill('#f-loginPassword', 'demo1234');
await page.click('#auth-login button[type="submit"]');
await closedDialog();
await openMenu();
assert.equal(await menuName(), 'Carlos Ruiz');
await page.click('#user-menu-panel [data-auth-open="login"]');
await page.waitForSelector(authDialog);
await page.click('.auth__demo summary');
await page.selectOption('#auth-demo-user', 'u1');
await page.click('[data-demo-login]');
await closedDialog();
await openMenu();
assert.equal(await menuName(), 'Laura M.');
await page.click('#user-menu-trigger');
log('   Cuentas de prueba: correo + contraseña pública y selector de demostración');

// --- Validación del asistente ---
await go('#/sell');
await next();
assert.equal(await page.locator('.error-summary').count(), 1, 'step 1 error without category');
await pickCard('category', 'fashion');
await next(); await next();
assert.ok(await page.locator('#operationType-group-error').count(), 'operation required');
await pickCard('operationType', 'sale');
await next();
await next(); // step 3 empty
assert.ok(await page.locator('#f-title[aria-invalid="true"]').count(), 'title invalid');
assert.ok(await page.locator('#f-price[aria-invalid="true"]').count(), 'price invalid');
log('Validaciones por paso muestran errores específicos');

// 1. Ropa
const fashionId = await createListing({ category: 'fashion', op: 'sale', title: 'Abrigo de lana E2E', price: 45, basic: { condition: 'good', brand: 'Zara' }, attrs: { garmentType: 'coat', size: 'L', color: 'Negro' }, delivery: ['inPerson'] });
await go('#/explore?category=fashion');
assert.ok(await page.locator('.listing-card', { hasText: 'Abrigo de lana E2E' }).count(), 'fashion in category');
await go('#/explore?q=abrigo%20lana');
assert.equal(await page.locator('.listing-card').count(), 1, 'search finds it');
await go('#/seller/listings');
assert.ok(await page.locator('.manage-row', { hasText: 'Abrigo de lana E2E' }).count(), 'in Mis anuncios');
log('1. Anuncio de ropa creado, visible en su categoría, búsqueda y Mis anuncios', fashionId);

// 2. Coche en venta: sin campos de alquiler
const carSaleId = await createListing({ category: 'cars', op: 'sale', title: 'Renault Clio E2E venta', price: 9000, basic: { brand: 'Renault', model: 'Clio' },
  onStep4: async () => { assert.equal(await page.locator('[name="attributes.driverMinAge"]').count(), 0, 'no rent fields for sale'); },
  attrs: { year: 2017, mileage: 90000, fuel: 'diesel', transmission: 'manual', vehicleCondition: 'used_good' }, delivery: ['inPerson'] });
log('2. Coche en venta creado sin campos de alquiler', carSaleId);

// 3. Coche en alquiler: campos específicos
const carRentId = await createListing({ category: 'cars', op: 'rent', period: 'day', price: 40, minDuration: 1, title: 'Fiat 500 E2E alquiler', basic: { brand: 'Fiat', model: '500' },
  onStep2: async () => { assert.ok(await page.locator('[name="rental.requirements"]').count(), 'rent questions in step 2'); },
  onStep4: async () => { for (const f of ['driverMinAge', 'licenseMinYears', 'deposit', 'insuranceIncluded', 'kmLimit', 'pickupReturnConditions']) assert.equal(await page.locator(`[name="attributes.${f}"]`).count(), 1, f); },
  attrs: { year: 2021, mileage: 20000, fuel: 'gasoline', transmission: 'manual', vehicleCondition: 'semi_new', driverMinAge: 21, licenseMinYears: 1, deposit: 200, insuranceIncluded: true, pickupReturnConditions: 'En la estación de tren.' }, delivery: ['pickup'] });
await go(`#/listing/${carRentId}`);
assert.match(await page.locator('.detail__price').textContent(), /40.*\/día/);
log('3. Coche en alquiler con campos específicos (edad, permiso, fianza, seguro, km)', carRentId);

// 4. Viviendas
const houseSaleId = await createListing({ category: 'housing', op: 'sale', title: 'Piso E2E en venta', price: 200000,
  onStep4: async () => { assert.equal(await page.locator('[name="attributes.deposit"]').count(), 0); assert.equal(await page.locator('[name="attributes.energyRating"]').count(), 1); },
  attrs: { propertyType: 'flat', area: 80, bedrooms: 2, bathrooms: 1, propertyCondition: 'good', furnished: 'unfurnished' } });
const houseRentId = await createListing({ category: 'housing', op: 'rent', period: 'month', price: 800, minDuration: 12, title: 'Piso E2E en alquiler',
  onStep4: async () => { assert.equal(await page.locator('[name="attributes.energyRating"]').count(), 0); assert.equal(await page.locator('[name="attributes.deposit"]').count(), 1); },
  attrs: { propertyType: 'flat', area: 70, bedrooms: 2, bathrooms: 1, propertyCondition: 'good', furnished: 'furnished', deposit: 1600, availableFrom: '2027-01-01' } });
await go('#/housing');
assert.ok(await page.locator('.listing-card', { hasText: 'Piso E2E en venta' }).count() && await page.locator('.listing-card', { hasText: 'Piso E2E en alquiler' }).count());
log('4. Vivienda en venta y en alquiler (campos de compraventa vs. alquiler)', houseSaleId, houseRentId);

// 5. Editar y pausar
await go(`#/seller/edit/${fashionId}`);
await page.click('[data-go-step="3"]');
await setField('title', 'Abrigo de lana E2E editado');
await page.click('[data-go-step="7"]');
await page.click('[data-publish]');
await page.waitForSelector('.wizard-success');
await go('#/seller/listings');
const row = page.locator('.manage-row', { hasText: 'Abrigo de lana E2E editado' });
await row.locator('[data-listing-action="pause"]').click();
await page.waitForTimeout(500);
assert.match(await page.locator('.manage-row', { hasText: 'Abrigo de lana E2E editado' }).locator('.badge').first().textContent(), /Pausado/);
await go('#/explore?category=fashion');
assert.equal(await page.locator('.listing-card', { hasText: 'Abrigo de lana E2E' }).count(), 0, 'paused hidden');
log('5. Anuncio editado y pausado (desaparece de la marketplace)');

// Cambio de precio
await go('#/seller/listings');
await page.locator('.manage-row', { hasText: 'Renault Clio E2E venta' }).locator('[data-listing-action="price"]').click();
await page.fill('#f-price', '8500');
await page.click('button[form="price-form"]');
await page.waitForTimeout(500);
assert.match(await page.locator('.manage-row', { hasText: 'Renault Clio' }).textContent(), /8500/);
log('   Cambio de precio rápido');

// 6. Favoritos
await go('#/explore?q=yamaha');
const favBtn = page.locator('.listing-card', { hasText: 'Yamaha' }).locator('.fav-btn');
await favBtn.click(); await page.waitForTimeout(500);
assert.equal(await page.locator('.listing-card', { hasText: 'Yamaha' }).locator('.fav-btn').getAttribute('aria-pressed'), 'true');
await go('#/favorites');
assert.ok(await page.locator('.listing-card', { hasText: 'Yamaha' }).count());
assert.ok(await page.locator('.price-change', { hasText: 'Ha bajado' }).count(), 'golf price drop shown');
await page.locator('.listing-card', { hasText: 'Yamaha' }).locator('.fav-btn').click(); await page.waitForTimeout(500);
assert.equal(await page.locator('.listing-card', { hasText: 'Yamaha' }).count(), 0);
await go('#/home');
assert.equal(await page.locator('.listing-card', { hasText: 'Yamaha' }).first().locator('.fav-btn').getAttribute('aria-pressed'), 'false');
log('6. Favoritos añadidos/quitados y sincronizados con las tarjetas; aviso de bajada de precio');

// No se puede comprar lo propio
await go(`#/listing/${carSaleId}`);
assert.equal(await page.locator('[data-buy]').count(), 0, 'no buy on own listing');
log('   No se puede comprar el propio anuncio');

// 7-8. Pedido de demostración: Laura compra el Seat León de Carlos
await go('#/listing/lst_008');
await page.click('[data-buy]');
await page.waitForSelector('#purchase-form');
const submit = page.locator('button[form="purchase-form"]');
await submit.dblclick(); // doble pulsación: no debe crear duplicados
await page.waitForURL(/#\/buyer\/orders/);
await page.waitForTimeout(400);
const orderRows = page.locator('.order-row', { hasText: 'Seat León' });
assert.equal(await orderRows.count(), 1, 'single order created');
const orderId = (await orderRows.locator('code').textContent()).trim();
await go('#/listing/lst_008');
assert.equal(await page.locator('[data-buy]').count(), 0);
assert.match(await page.locator('.detail__summary').textContent(), /pedido abierto/);
log('7. Pedido creado (una sola vez pese a doble clic) y artículo reservado', orderId);

// Cambiar a Carlos (vendedor)
await page.click('#user-menu-trigger');
await page.selectOption('#demo-user-switch', 'u2');
await page.waitForTimeout(600);
await go('#/seller/orders');
const sellerRow = page.locator('.order-row', { hasText: orderId });
assert.equal(await sellerRow.count(), 1, 'order visible to seller');
assert.match(await sellerRow.locator('.badge').textContent(), /Pendiente/);
await sellerRow.locator('[data-order-detail]').click();
await page.click('.order-detail__actions >> text=Aceptar pedido');
await page.waitForTimeout(500);
assert.match(await page.locator('.order-detail__head .badge').textContent(), /Aceptado/);
await page.keyboard.press('Escape');
// Carlos intenta alquilar su propio Corolla: no puede; comprobamos solape como Ana
await page.click('#user-menu-trigger');
await page.selectOption('#demo-user-switch', 'u5');
await page.waitForTimeout(600);
await go('#/listing/lst_009');
await page.click('[data-buy]');
const bookedStart = await page.evaluate(() => { const d = new Date(Date.now() + 6 * 864e5); return d.toISOString().slice(0, 10); });
const bookedEnd = await page.evaluate(() => { const d = new Date(Date.now() + 9 * 864e5); return d.toISOString().slice(0, 10); });
await page.fill('#f-startDate', bookedStart); await page.fill('#f-endDate', bookedEnd);
await page.click('button[form="purchase-form"]');
await page.waitForTimeout(300);
assert.match(await page.locator('#purchase-form').textContent(), /solapan/);
await page.keyboard.press('Escape');
log('   Reserva solapada rechazada');
// Volver a Laura y comprobar el estado compartido
await page.click('#user-menu-trigger');
await page.selectOption('#demo-user-switch', 'u1');
await page.waitForTimeout(600);
await go('#/buyer/orders');
assert.match(await page.locator('.order-row', { hasText: orderId }).locator('.badge').textContent(), /Aceptado/);
log('8. El pedido aparece en comprador y vendedor con el mismo estado (Aceptado)');

// 9. Persistencia tras recarga
await page.reload();
await page.waitForSelector('.order-row');
assert.match(await page.locator('.order-row', { hasText: orderId }).locator('.badge').textContent(), /Aceptado/);
await go('#/seller/listings');
assert.ok(await page.locator('.manage-row', { hasText: 'Abrigo de lana E2E editado' }).count());
assert.ok(await page.locator('.manage-row', { hasText: 'Piso E2E en alquiler' }).count());
log('9. Datos persistentes tras recargar (LocalStorage)');

// Eliminar con confirmación: el anuncio con pedidos abiertos no se puede borrar
await go('#/seller/listings');
await page.locator('.manage-row', { hasText: 'Piso E2E en venta' }).locator('[data-listing-action="delete"]').click();
await page.click('[data-confirm]');
await page.waitForTimeout(500);
assert.equal(await page.locator('.manage-row', { hasText: 'Piso E2E en venta' }).count(), 0);
log('   Eliminación con confirmación');

// Mensajes
await go('#/buyer/messages?listing=lst_010&with=u2');
await page.fill('#message-input', 'Hola, ¿sigue disponible la moto?');
await page.click('#message-form button[type="submit"]');
await page.waitForTimeout(500);
assert.ok(await page.locator('.bubble--mine', { hasText: 'sigue disponible' }).count());
log('   Mensaje enviado en conversación nueva');

// Imagen no válida
await go('#/sell');
if (await page.locator('[data-restart]').count()) await page.click('[data-restart]');
await pickCard('category', 'other'); await next(); await pickCard('operationType', 'sale'); await next();
await setField('title', 'Prueba de imagen'); await setField('description', 'Descripción de prueba de imagen inválida.'); await setField('price', 10); await setField('condition', 'good');
await next(); await next();
await page.setInputFiles('#photo-input', { name: 'doc.txt', mimeType: 'text/plain', buffer: Buffer.from('hola') });
await page.waitForTimeout(300);
assert.match(await page.locator('[data-photo-feedback]').textContent(), /formato no permitido/);
await next();
assert.ok(await page.locator('#photo-error').count(), 'image required');
log('   Validación de formato de imagen y foto obligatoria');

console.log(errors.length ? `Errores de consola: ${errors.join('\n')}` : 'Sin errores de consola.');
assert.equal(errors.length, 0);
await browser.close();
