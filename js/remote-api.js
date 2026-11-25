/**
 * remote-api.js
 * ---------------------------------------------------------------------------
 * RemoteApi: la "API" de la web con los datos guardados en Neon (Postgres).
 *
 *  - Cuentas y sesión: Neon Auth (neon-auth.js).
 *  - Datos: Neon Data API (REST compatible con PostgREST). Cada petición
 *    lleva el JWT de la sesión (o uno anónimo para invitados) y la base de
 *    datos decide qué puede ver o cambiar cada usuario (RLS, db/schema.sql).
 *  - Las reglas de negocio (no comprar lo propio, pedidos duplicados,
 *    reservas solapadas, transiciones de estado…) se aplican en funciones de
 *    la base de datos (/rpc/...). Aquí solo se repiten las validaciones de
 *    formulario para dar mensajes inmediatos.
 *
 * Tiene los mismos métodos que LocalApi (api.js), así que la interfaz no
 * cambia. getSnapshot() descarga las tablas que el usuario puede ver y las
 * convierte al mismo modelo de datos (camelCase) que usa la versión local.
 */

import { APP_CONFIG, DEMO_ACCOUNTS, defaultUserPreferences, resolveImageSrc } from './data.js';
import { validateListing } from './validation.js';
import { NeonAuthClient } from './neon-auth.js';
import {
  ApiError, buildListingFields, EMAIL_PATTERN, neonError, passwordProblem, sameText, USERNAME_PATTERN,
} from './api-shared.js';

const REQUEST_TIMEOUT_MS = 20_000;

/** Fecha ISO uniforme (2026-11-25T09:11:44.528Z): la interfaz compara fechas como texto. */
const iso = (value) => (value ? new Date(value).toISOString() : value ?? null);
const num = (value) => (value === null || value === undefined ? null : Number(value));

/** Segundos que le quedan a un JWT (lee el campo exp sin verificar la firma). */
function secondsLeft(jwt) {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.exp - Date.now() / 1000;
  } catch {
    return 0;
  }
}

/* --------------------------------------------------------------------------
   Conversión filas de la base de datos ↔ modelo de la interfaz
   -------------------------------------------------------------------------- */

function mergePreferences(preferences) {
  const defaults = defaultUserPreferences();
  return {
    notifications: { ...defaults.notifications, ...(preferences?.notifications ?? {}) },
    privacy: { ...defaults.privacy, ...(preferences?.privacy ?? {}) },
  };
}

function toUser(row, privateRow = null) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
    avatar: row.avatar,
    bio: row.bio,
    publicLocation: row.public_location,
    preferences: mergePreferences(row.preferences),
    role: row.role,
    createdAt: iso(row.created_at),
    // Todas las cuentas están en Neon Auth; las de prueba usan la contraseña pública.
    demo: row.is_demo,
    remote: true,
    // Datos privados: solo llegan los del propio usuario (RLS).
    email: privateRow?.email ?? '',
    phone: privateRow?.phone ?? '',
    birthDate: privateRow?.birth_date ?? '',
    country: privateRow?.country ?? 'España',
    city: privateRow?.city ?? '',
    address: privateRow?.address ?? '',
  };
}

function toListing(row, favoriteCount = 0) {
  return {
    id: row.id,
    sellerId: row.seller_id,
    title: row.title,
    description: row.description,
    category: row.category,
    subcategory: row.subcategory,
    operationType: row.operation_type,
    price: num(row.price),
    currency: row.currency,
    rental: row.rental,
    condition: row.condition,
    brand: row.brand,
    model: row.model,
    availability: row.availability,
    deliveryNotes: row.delivery_notes,
    attributes: row.attributes ?? {},
    customAttributes: row.custom_attributes ?? [],
    images: (row.images ?? []).map((image) => ({ ...image, src: resolveImageSrc(image.src) })),
    location: { city: '', postalCode: '', zone: '', ...(row.location ?? {}) },
    delivery: { inPerson: false, shipping: false, pickup: false, agreed: false, ...(row.delivery ?? {}) },
    status: row.status,
    featured: row.featured,
    views: row.views,
    priceHistory: (row.price_history ?? []).map((entry) => ({ price: num(entry.price), date: iso(entry.date) })),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: iso(row.deleted_at),
    favoriteCount,
  };
}

/** Campos del asistente (buildListingFields) → columnas de la tabla listings. */
function toListingRow(fields) {
  return {
    title: fields.title,
    description: fields.description,
    category: fields.category,
    subcategory: fields.subcategory,
    operation_type: fields.operationType,
    price: fields.price,
    currency: fields.currency,
    rental: fields.rental,
    condition: fields.condition,
    brand: fields.brand,
    model: fields.model,
    availability: fields.availability,
    delivery_notes: fields.deliveryNotes,
    attributes: fields.attributes,
    custom_attributes: fields.customAttributes,
    images: fields.images,
    location: fields.location,
    delivery: fields.delivery,
  };
}

function toOrder(row) {
  return {
    id: row.id,
    listingId: row.listing_id,
    buyerId: row.buyer_id,
    sellerId: row.seller_id,
    operationType: row.operation_type,
    amount: num(row.amount),
    currency: row.currency,
    units: row.units,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    delivery: row.delivery ?? {},
    statusHistory: (row.status_history ?? []).map((entry) => ({ ...entry, date: iso(entry.date) })),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/**
 * Reserva pública (vista listing_reservations): sirve para mostrar «Reservado»
 * y las fechas ocupadas sin saber quién compra. No aparece en los paneles
 * porque no tiene comprador ni vendedor.
 */
function toReservation(row) {
  return {
    id: row.id, listingId: row.listing_id, operationType: row.operation_type, status: row.status,
    startDate: row.start_date, endDate: row.end_date, buyerId: null, sellerId: null,
    amount: 0, currency: 'EUR', units: null, delivery: {}, statusHistory: [], createdAt: '', updatedAt: '', isPublicReservation: true,
  };
}

const toFavorite = (row) => ({ id: row.id, userId: row.user_id, listingId: row.listing_id, createdAt: iso(row.created_at) });
const toMessage = (row) => ({
  id: row.id, conversationId: row.conversation_id, listingId: row.listing_id, senderId: row.sender_id,
  receiverId: row.receiver_id, content: row.content, createdAt: iso(row.created_at), read: row.read,
});
const toReview = (row) => ({
  id: row.id, orderId: row.order_id, listingId: row.listing_id, reviewerId: row.reviewer_id,
  revieweeId: row.reviewee_id, rating: row.rating, comment: row.comment, createdAt: iso(row.created_at),
});
const toReport = (row) => ({
  id: row.id, type: row.type, userId: row.user_id, listingId: row.listing_id, reason: row.reason,
  details: row.details, status: row.status, createdAt: iso(row.created_at),
});

/** Campos del perfil que van a la tabla pública y a la privada. */
const PUBLIC_PROFILE_FIELDS = {
  username: 'username', displayName: 'display_name', firstName: 'first_name', lastName: 'last_name',
  avatar: 'avatar', bio: 'bio', publicLocation: 'public_location', preferences: 'preferences',
};
const PRIVATE_PROFILE_FIELDS = {
  phone: 'phone', birthDate: 'birth_date', country: 'country', city: 'city', address: 'address',
};

/* ==========================================================================
   RemoteApi
   ========================================================================== */

export class RemoteApi {
  constructor() {
    this.baseUrl = APP_CONFIG.dataApiUrl.replace(/\/+$/, '');
    this.remote = new NeonAuthClient(APP_CONFIG.neonAuthUrl);
    this.persistent = true;
    /** Usuario con sesión en Neon Auth (null = invitado) y su JWT para la Data API. */
    this.userId = null;
    this.jwt = null;
    this.anonymousJwt = null;
    /** Última copia descargada: se usa para validar en el cliente antes de escribir. */
    this.snapshot = null;
  }

  get usesRemoteAccounts() { return true; }
  get dataSource() { return 'neon'; }
  /** Los datos son compartidos: no se pueden restablecer desde la web (ver db/seed.sql). */
  get canResetDemo() { return false; }

  /* ---------------------------- Sesión y tokens -------------------------- */

  async init() {
    await this.#refreshSession();
    if (this.userId) await this.#ensureProfile();
    return true;
  }

  /** Lee la sesión de Neon Auth (cookie) y guarda el JWT para la Data API. */
  async #refreshSession() {
    let session = null;
    try {
      session = await this.remote.getSession();
    } catch (error) {
      console.warn('No se pudo comprobar la sesión de Neon Auth.', error);
    }
    this.userId = session?.user?.id ?? null;
    this.jwt = session?.jwt ?? null;
    this.sessionUser = session?.user ?? null;
  }

  /** JWT para la próxima petición: el de la sesión o uno anónimo; se renuevan antes de caducar. */
  async #token() {
    if (this.userId) {
      if (!this.jwt || secondsLeft(this.jwt) < 60) await this.#refreshSession();
      if (this.jwt) return this.jwt;
    }
    if (!this.anonymousJwt || secondsLeft(this.anonymousJwt) < 60) {
      try {
        this.anonymousJwt = (await this.remote.getAnonymousToken())?.token ?? null;
      } catch (error) {
        throw neonError(error);
      }
    }
    return this.anonymousJwt;
  }

  /** Petición a la Data API. Traduce los errores de la base de datos a ApiError. */
  async #request(method, path, { body, prefer = null, retry = true } = {}) {
    const token = await this.#token();
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(prefer ? { Prefer: prefer } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout?.(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError('No se pudo conectar con la base de datos. Comprueba tu conexión e inténtalo de nuevo.', 'network');
    }
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (response.ok) return payload;

    // Token caducado: se renueva una vez y se repite la petición.
    if (response.status === 401 && retry) {
      this.jwt = null;
      this.anonymousJwt = null;
      if (this.userId) await this.#refreshSession();
      return this.#request(method, path, { body, prefer, retry: false });
    }
    throw this.#translateError(payload, response.status);
  }

  #translateError(payload, status) {
    const known = ['auth_required', 'forbidden', 'not_found', 'unavailable', 'validation', 'duplicate', 'overlap', 'invalid_transition', 'invalid_state', 'conflict'];
    if (payload?.hint && known.includes(payload.hint)) return new ApiError(payload.message, payload.hint);
    if (payload?.code === '42501') {
      return this.userId
        ? new ApiError('No tienes permiso para hacer esto.', 'forbidden')
        : new ApiError('Inicia sesión o crea una cuenta para continuar.', 'auth_required');
    }
    if (payload?.code === '23505') return new ApiError('Ya existe un registro con esos datos.', 'conflict');
    if (payload?.code === '23514' || payload?.code === '22001') return new ApiError('Algún dato no es válido o es demasiado largo.', 'validation');
    if (status === 413) return new ApiError('Las fotos ocupan demasiado. Prueba con menos o más pequeñas.', 'too_large');
    console.error('Error de la Data API', status, payload);
    return new ApiError('La base de datos no ha podido completar la operación. Inténtalo de nuevo.', 'server_error');
  }

  #rpc(name, args = {}) {
    return this.#request('POST', `/rpc/${name}`, { body: args });
  }

  #assertUser() {
    if (!this.userId) throw new ApiError('Inicia sesión o crea una cuenta para continuar.', 'auth_required');
  }

  /**
   * Crea el perfil de una cuenta de Neon Auth si todavía no lo tiene (primer
   * acceso). El nombre de usuario se deduce del correo si no se indica.
   */
  async #ensureProfile({ username = null, firstName = null, lastName = null } = {}) {
    const existing = await this.#request('GET', `/profiles?select=id&id=eq.${encodeURIComponent(this.userId)}`);
    if (existing?.length) return;
    const user = this.sessionUser ?? {};
    const [nameFirst = '', ...nameRest] = String(user.name ?? '').trim().split(/\s+/);
    let base = username ?? String(user.email ?? 'usuario').split('@')[0].toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 16);
    if (base.length < 3) base = `usuario${base}`;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base.slice(0, 16)}${Math.floor(100 + Math.random() * 900)}`;
      try {
        await this.#request('POST', '/profiles', {
          body: {
            username: candidate,
            display_name: String(user.name ?? '').trim() || candidate,
            first_name: firstName ?? nameFirst,
            last_name: lastName ?? nameRest.join(' '),
            preferences: defaultUserPreferences(),
          },
          prefer: 'return=minimal',
        });
        await this.#request('POST', '/profile_private', { body: { user_id: this.userId, email: user.email ?? '' }, prefer: 'resolution=merge-duplicates,return=minimal' });
        return;
      } catch (error) {
        if (error.code !== 'conflict') throw error;
      }
    }
    throw new ApiError('No se pudo crear tu perfil. Inténtalo de nuevo.', 'conflict');
  }

  async getCurrentUserId() {
    // Solo cuenta como sesión si el perfil existe (se crea en el primer acceso).
    return this.userId && this.snapshot?.users.some((user) => user.id === this.userId) ? this.userId : null;
  }

  /* ------------------------------ Lectura -------------------------------- */

  async getSnapshot() {
    const mine = Boolean(this.userId);
    const empty = Promise.resolve([]);
    const [profiles, privateRows, listings, favoriteCounts, reservations, orders, favorites, messages, reviews, reports] = await Promise.all([
      this.#request('GET', '/profiles?select=*'),
      mine ? this.#request('GET', '/profile_private?select=*') : empty,
      this.#request('GET', '/listings?select=*&order=created_at.desc'),
      this.#request('GET', '/listing_favorite_counts?select=*'),
      this.#request('GET', '/listing_reservations?select=*'),
      mine ? this.#request('GET', '/orders?select=*&order=created_at.desc') : empty,
      mine ? this.#request('GET', '/favorites?select=*') : empty,
      mine ? this.#request('GET', '/messages?select=*&order=created_at.asc') : empty,
      this.#request('GET', '/reviews?select=*&order=created_at.desc'),
      mine ? this.#request('GET', '/reports?select=*&order=created_at.desc') : empty,
    ]);
    const counts = new Map(favoriteCounts.map((row) => [row.listing_id, row.favorites]));
    const myOrders = orders.map(toOrder);
    const myOrderIds = new Set(myOrders.map((order) => order.id));
    this.snapshot = {
      version: 1,
      users: profiles.map((row) => toUser(row, row.id === this.userId ? privateRows[0] : null)),
      listings: listings.map((row) => toListing(row, counts.get(row.id) ?? 0)),
      orders: [...myOrders, ...reservations.filter((row) => !myOrderIds.has(row.id)).map(toReservation)],
      favorites: favorites.map(toFavorite),
      messages: messages.map(toMessage),
      reviews: reviews.map(toReview),
      reports: reports.map(toReport),
    };
    return structuredClone(this.snapshot);
  }

  #cachedListing(listingId) {
    return this.snapshot?.listings.find((listing) => listing.id === listingId) ?? null;
  }

  async resetDemoData() {
    throw new ApiError('Con la base de datos de Neon los datos son compartidos y no se pueden restablecer desde la web. Usa db/seed.sql en el SQL Editor de Neon.', 'forbidden');
  }

  /* ------------------------------ Cuentas -------------------------------- */

  /** Entra en una cuenta de prueba con la contraseña pública. */
  async switchDemoUser(userId) {
    const profile = this.snapshot?.users.find((user) => user.id === userId && user.demo);
    const account = DEMO_ACCOUNTS.find((candidate) => candidate.username === profile?.username);
    if (!account) throw new ApiError('Usuario de demostración no encontrado.', 'not_found');
    return this.login({ identifier: account.email, password: APP_CONFIG.demoPassword });
  }

  async login({ identifier, password }) {
    const errors = {};
    const id = String(identifier ?? '').trim();
    if (!id) errors.identifier = 'Escribe tu correo o nombre de usuario.';
    if (!password) errors.password = 'Escribe tu contraseña.';
    if (Object.keys(errors).length) throw new ApiError('Completa los campos para entrar.', 'validation', errors);
    // Con el nombre de usuario solo se puede entrar en las cuentas de prueba (el correo de los demás es privado).
    const email = EMAIL_PATTERN.test(id) ? id.toLowerCase() : DEMO_ACCOUNTS.find((account) => sameText(account.username, id))?.email;
    if (!email) {
      throw new ApiError('Escribe el correo de tu cuenta.', 'validation', { identifier: 'Escribe el correo con el que te registraste.' });
    }
    if (this.userId) await this.#signOutQuietly();
    try {
      await this.remote.signIn({ email, password });
    } catch (error) { throw neonError(error, { context: 'login' }); }
    await this.#refreshSession();
    if (!this.userId) throw new ApiError('No se pudo iniciar la sesión. Si tu navegador bloquea las cookies de otros sitios, permítelas para esta página.', 'session_blocked');
    await this.#ensureProfile();
    return { id: this.userId };
  }

  async register(data) {
    const values = {
      firstName: String(data.firstName ?? '').trim(),
      lastName: String(data.lastName ?? '').trim(),
      username: String(data.username ?? '').trim().toLowerCase(),
      email: String(data.email ?? '').trim().toLowerCase(),
      password: String(data.password ?? ''),
      passwordConfirm: String(data.passwordConfirm ?? ''),
      acceptTerms: Boolean(data.acceptTerms),
    };
    const errors = {};
    if (values.firstName.length < 2) errors.firstName = 'Indica tu nombre.';
    if (values.lastName.length < 2) errors.lastName = 'Indica tus apellidos.';
    if (!USERNAME_PATTERN.test(values.username)) errors.username = 'Entre 3 y 20 caracteres en minúscula: letras, números, «_» o «.».';
    else if ((await this.#request('GET', `/profiles?select=id&username=eq.${encodeURIComponent(values.username)}`)).length) {
      errors.username = 'Ese nombre de usuario ya está en uso.';
    }
    if (!EMAIL_PATTERN.test(values.email)) errors.email = 'Introduce un correo electrónico válido.';
    const problem = passwordProblem(values.password);
    if (problem) errors.password = problem;
    else if (values.password !== values.passwordConfirm) errors.passwordConfirm = 'Las contraseñas no coinciden.';
    if (!values.acceptTerms) errors.acceptTerms = 'Debes aceptar las condiciones para crear la cuenta.';
    if (Object.keys(errors).length) throw new ApiError('Revisa los campos marcados.', 'validation', errors);

    if (this.userId) await this.#signOutQuietly();
    try {
      await this.remote.signUp({ name: `${values.firstName} ${values.lastName}`, email: values.email, password: values.password });
    } catch (error) { throw neonError(error, { context: 'register' }); }
    await this.#refreshSession();
    if (!this.userId) throw new ApiError('La cuenta se ha creado, pero no se pudo iniciar la sesión. Si tu navegador bloquea las cookies de otros sitios, permítelas para esta página e inicia sesión.', 'session_blocked');
    await this.#ensureProfile({ username: values.username, firstName: values.firstName, lastName: values.lastName });
    return { id: this.userId };
  }

  async #signOutQuietly() {
    try { await this.remote.signOut(); } catch { /* sin sesión o sin red */ }
    this.userId = null;
    this.jwt = null;
    this.sessionUser = null;
  }

  async logout() {
    await this.#signOutQuietly();
    return true;
  }

  async changePassword(actorId, { currentPassword, newPassword, newPasswordConfirm }) {
    this.#assertUser();
    const me = this.snapshot?.users.find((user) => user.id === this.userId);
    if (me?.demo) throw new ApiError('Las cuentas de prueba usan una contraseña pública que no se puede cambiar.', 'forbidden');
    const errors = {};
    if (!currentPassword) errors.currentPassword = 'Escribe tu contraseña actual.';
    const problem = passwordProblem(newPassword);
    if (problem) errors.newPassword = problem;
    else if (newPassword !== newPasswordConfirm) errors.newPasswordConfirm = 'Las contraseñas no coinciden.';
    if (Object.keys(errors).length) throw new ApiError('Revisa los campos marcados.', 'validation', errors);
    try {
      await this.remote.changePassword({ currentPassword, newPassword });
    } catch (error) { throw neonError(error, { context: 'password' }); }
    return true;
  }

  async updateUser(actorId, userId, patch) {
    this.#assertUser();
    if (userId !== this.userId) throw new ApiError('Solo puedes modificar tu propio perfil.', 'forbidden');
    const me = this.snapshot?.users.find((user) => user.id === this.userId);
    if (patch.email !== undefined && me && !sameText(patch.email, me.email)) {
      throw new ApiError('El correo de la cuenta no se puede cambiar desde aquí todavía.', 'forbidden');
    }
    const publicRow = {};
    const privateRow = {};
    Object.entries(patch).forEach(([key, value]) => {
      if (PUBLIC_PROFILE_FIELDS[key]) publicRow[PUBLIC_PROFILE_FIELDS[key]] = value;
      if (PRIVATE_PROFILE_FIELDS[key]) privateRow[PRIVATE_PROFILE_FIELDS[key]] = value ?? '';
    });
    if (publicRow.username !== undefined) {
      publicRow.username = String(publicRow.username).trim().toLowerCase();
      if (!USERNAME_PATTERN.test(publicRow.username)) throw new ApiError('El nombre de usuario debe tener entre 3 y 20 caracteres (letras, números, «_» o «.»).', 'validation');
    }
    if (Object.keys(publicRow).length) {
      try {
        await this.#request('PATCH', `/profiles?id=eq.${encodeURIComponent(this.userId)}`, { body: publicRow, prefer: 'return=minimal' });
      } catch (error) {
        if (error.code === 'conflict') throw new ApiError('Ese nombre de usuario ya está en uso.', 'conflict');
        throw error;
      }
    }
    if (Object.keys(privateRow).length) {
      await this.#request('POST', '/profile_private', {
        body: { user_id: this.userId, email: me?.email ?? '', ...privateRow },
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    }
    // El nombre visible de la cuenta de Neon Auth sigue al del perfil.
    const newName = `${patch.firstName ?? me?.firstName ?? ''} ${patch.lastName ?? me?.lastName ?? ''}`.trim();
    if (!me?.demo && newName && newName !== `${me?.firstName ?? ''} ${me?.lastName ?? ''}`.trim()) {
      try { await this.remote.updateUser({ name: newName }); } catch (error) { console.warn('No se pudo actualizar el nombre en Neon Auth.', error); }
    }
    return { id: this.userId };
  }

  /* ------------------------------ Anuncios ------------------------------- */

  async createListing(sellerId, data, { status = 'active' } = {}) {
    this.#assertUser();
    const mode = status === 'draft' ? 'draft' : 'publish';
    const errors = validateListing(data, { mode });
    if (Object.keys(errors).length) throw new ApiError('Revisa los campos marcados antes de continuar.', 'validation', errors);
    const rows = await this.#request('POST', '/listings', {
      body: { ...toListingRow(buildListingFields(data)), status: mode === 'draft' ? 'draft' : 'active' },
      prefer: 'return=representation',
    });
    return toListing(rows[0]);
  }

  async updateListing(actorId, listingId, data, { publish = false } = {}) {
    this.#assertUser();
    const current = this.#cachedListing(listingId);
    const mode = publish || (current && current.status !== 'draft') ? 'publish' : 'draft';
    const errors = validateListing(data, { mode });
    if (Object.keys(errors).length) throw new ApiError('Revisa los campos marcados antes de continuar.', 'validation', errors);
    const rows = await this.#request('PATCH', `/listings?id=eq.${encodeURIComponent(listingId)}`, {
      body: toListingRow(buildListingFields(data)),
      prefer: 'return=representation',
    });
    if (!rows?.length) throw new ApiError('Solo el propietario puede modificar este anuncio.', 'forbidden');
    if (publish && rows[0].status === 'draft') return toListing(await this.#rpc('publish_listing', { p_listing_id: listingId }));
    return toListing(rows[0]);
  }

  async changeListingPrice(actorId, listingId, newPrice) {
    this.#assertUser();
    const price = Number(newPrice);
    if (!Number.isFinite(price) || price <= 0) throw new ApiError('Introduce un precio mayor que cero.', 'validation');
    const rows = await this.#request('PATCH', `/listings?id=eq.${encodeURIComponent(listingId)}`, { body: { price }, prefer: 'return=representation' });
    if (!rows?.length) throw new ApiError('Solo el propietario puede modificar este anuncio.', 'forbidden');
    return toListing(rows[0]);
  }

  async changeListingStatus(actorId, listingId, nextStatus) {
    this.#assertUser();
    const current = this.#cachedListing(listingId);
    if (nextStatus === 'active' && current) {
      const errors = validateListing(current, { mode: 'publish' });
      if (Object.keys(errors).length) throw new ApiError('El anuncio está incompleto. Edítalo antes de reactivarlo.', 'validation', errors);
    }
    return toListing(await this.#rpc('set_listing_status', { p_listing_id: listingId, p_status: nextStatus }));
  }

  async deleteListing(actorId, listingId) {
    this.#assertUser();
    return { id: await this.#rpc('delete_listing', { p_listing_id: listingId }) };
  }

  async registerView(viewerId, listingId) {
    return this.#rpc('register_view', { p_listing_id: listingId });
  }

  /* ----------------------------- Favoritos ------------------------------- */

  async toggleFavorite(userId, listingId) {
    this.#assertUser();
    return { favorite: await this.#rpc('toggle_favorite', { p_listing_id: listingId }) };
  }

  /* --------------------------- Pedidos y reservas ------------------------ */

  async createOrder(buyerId, { listingId, startDate = null, endDate = null, deliveryMethod, notes = '' }) {
    this.#assertUser();
    return toOrder(await this.#rpc('create_order', {
      p_listing_id: listingId, p_delivery_method: deliveryMethod, p_start_date: startDate, p_end_date: endDate, p_notes: notes,
    }));
  }

  async updateOrderStatus(actorId, orderId, nextStatus) {
    this.#assertUser();
    return toOrder(await this.#rpc('update_order_status', { p_order_id: orderId, p_next_status: nextStatus }));
  }

  /* ----------------------------- Valoraciones ---------------------------- */

  async createReview(reviewerId, { orderId, rating, comment }) {
    this.#assertUser();
    const score = Number(rating);
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new ApiError('Selecciona una puntuación de 1 a 5 estrellas.', 'validation');
    return toReview(await this.#rpc('create_review', { p_order_id: orderId, p_rating: score, p_comment: String(comment ?? '') }));
  }

  /* ------------------------------ Mensajes ------------------------------- */

  async sendMessage(senderId, { listingId, receiverId, content }) {
    this.#assertUser();
    const text = String(content ?? '').trim();
    if (!text) throw new ApiError('Escribe un mensaje.', 'validation');
    if (text.length > 1000) throw new ApiError('El mensaje no puede superar los 1000 caracteres.', 'validation');
    return toMessage(await this.#rpc('send_message', { p_listing_id: listingId, p_receiver_id: receiverId, p_content: text }));
  }

  async markConversationRead(userId, conversationId) {
    this.#assertUser();
    return this.#rpc('mark_conversation_read', { p_conversation_id: conversationId });
  }

  /* ------------------------- Denuncias y soporte ------------------------- */

  async createReport(userId, { type, listingId = null, reason, details }) {
    this.#assertUser();
    if (!reason) throw new ApiError('Selecciona un motivo.', 'validation');
    const text = String(details ?? '').trim();
    if (text.length < 10) throw new ApiError('Describe el problema con al menos 10 caracteres.', 'validation');
    const rows = await this.#request('POST', '/reports', {
      body: { type, listing_id: listingId, reason, details: text.slice(0, 1000) },
      prefer: 'return=representation',
    });
    return toReport(rows[0]);
  }
}
