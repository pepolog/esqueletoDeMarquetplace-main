/**
 * api-shared.js
 * ---------------------------------------------------------------------------
 * Piezas comunes a las dos implementaciones de la "API":
 *  - LocalApi (api.js): todo en el navegador (LocalStorage).
 *  - RemoteApi (remote-api.js): datos en Neon mediante la Data API.
 * Errores de negocio, reglas de reservas, validación de cuentas y la
 * normalización de los datos del asistente al modelo de anuncio.
 */

import { APP_CONFIG, getCategory, OPEN_ORDER_STATUSES } from './data.js';
import { NeonAuthError } from './neon-auth.js';

/** Error de negocio con mensaje apto para mostrar al usuario. */
export class ApiError extends Error {
  constructor(message, code = 'error', details = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

export const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/* --------------------------------------------------------------------------
   Utilidades de reglas de negocio (exportadas para que la interfaz pueda
   mostrar el mismo razonamiento antes de llamar a la API).
   -------------------------------------------------------------------------- */

/** Convierte una fecha «AAAA-MM-DD» o «AAAA-MM-DDTHH:mm» a milisegundos. */
export function toTime(value) {
  return new Date(value.length <= 10 ? `${value}T00:00` : value).getTime();
}

/**
 * Calcula cuántas unidades de alquiler (horas, días, semanas, meses) abarca
 * un intervalo. Para periodos diarios o superiores el día de devolución no
 * cuenta (del 10 al 12 = 2 días), con un mínimo de 1 unidad.
 */
export function computeRentalUnits(period, startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = toTime(startDate);
  const end = toTime(endDate);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  const hours = (end - start) / 3_600_000;
  const days = Math.round(hours / 24);
  switch (period) {
    case 'hour': return Math.max(1, Math.ceil(hours));
    case 'day': return Math.max(1, days);
    case 'week': return Math.max(1, Math.ceil(days / 7));
    case 'month': return Math.max(1, Math.ceil(days / 30));
    default: return 0;
  }
}

/** Intervalo [inicio, fin) en milisegundos. Una reserva de un solo día ocupa ese día completo. */
function bookingInterval(order) {
  const start = toTime(order.startDate);
  let end = toTime(order.endDate);
  if (end <= start) end = start + 86_400_000;
  return [start, end];
}

/** ¿Se solapan dos reservas? */
export function bookingsOverlap(a, b) {
  const [aStart, aEnd] = bookingInterval(a);
  const [bStart, bEnd] = bookingInterval(b);
  return aStart < bEnd && bStart < aEnd;
}

/** Reservas confirmadas o en curso que bloquean el calendario de un anuncio. */
export function blockingBookings(orders, listingId) {
  return orders.filter((order) => order.listingId === listingId && order.operationType === 'rent' && ['confirmed', 'in_progress'].includes(order.status));
}

/** Pedido de venta abierto (reservado) para un anuncio, si existe. */
export function openSaleOrder(orders, listingId) {
  return orders.find((order) => order.listingId === listingId && order.operationType === 'sale' && OPEN_ORDER_STATUSES.includes(order.status)) ?? null;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const USERNAME_PATTERN = /^[a-z0-9_.]{3,20}$/;

/** Devuelve el problema de una contraseña nueva o '' si es válida. */
export function passwordProblem(password) {
  const value = String(password ?? '');
  if (value.length < APP_CONFIG.passwordMinLength) return `Usa al menos ${APP_CONFIG.passwordMinLength} caracteres.`;
  if (value.length > 128) return 'La contraseña es demasiado larga (máximo 128 caracteres).';
  if (!/[A-Za-zÀ-ÿ]/.test(value) || !/[0-9]/.test(value)) return 'Combina letras y números.';
  return '';
}

/** Traduce los errores de Neon Auth (Better Auth) a mensajes para el usuario. */
export function neonError(error, { context = 'login' } = {}) {
  if (!(error instanceof NeonAuthError)) return error;
  const fieldError = (field, message) => new ApiError('Revisa los campos marcados.', 'validation', { [field]: message });
  switch (error.code) {
    case 'NETWORK':
      return new ApiError(`${error.message} Comprueba tu conexión e inténtalo de nuevo.`, 'network');
    case 'INVALID_EMAIL_OR_PASSWORD':
    case 'INVALID_EMAIL':
      return context === 'login'
        ? new ApiError('El correo, el usuario o la contraseña no son correctos.', 'invalid_credentials')
        : fieldError('email', 'Introduce un correo electrónico válido.');
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return fieldError('email', 'Ya existe una cuenta con ese correo. Inicia sesión.');
    case 'PASSWORD_TOO_SHORT':
      return fieldError(context === 'password' ? 'newPassword' : 'password', `Usa al menos ${APP_CONFIG.passwordMinLength} caracteres.`);
    case 'PASSWORD_TOO_LONG':
      return fieldError(context === 'password' ? 'newPassword' : 'password', 'La contraseña es demasiado larga.');
    case 'INVALID_PASSWORD':
      return fieldError('currentPassword', 'La contraseña actual no es correcta.');
    case 'EMAIL_NOT_VERIFIED':
      return new ApiError('Tienes que verificar tu correo antes de entrar. Revisa tu bandeja de entrada.', 'email_not_verified');
    default:
      if (error.status === 429) return new ApiError('Demasiados intentos seguidos. Espera un momento y vuelve a probar.', 'rate_limited');
      return new ApiError(`El servidor de cuentas no ha podido completar la operación (${error.message}).`, 'remote_error');
  }
}
export const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();


/** Normaliza los datos del asistente al modelo de anuncio (igual en local y en Neon). */
export function buildListingFields(data) {
  const category = getCategory(data.category);
  const attributes = {};
  category.fields
    .filter((field) => !field.showIf?.operationType || field.showIf.operationType === data.operationType)
    .forEach((field) => {
      const value = data.attributes?.[field.key];
      if (field.type === 'checkbox') attributes[field.key] = Boolean(value);
      else if (field.type === 'number') attributes[field.key] = value === '' || value === null || value === undefined ? null : Number(value);
      else attributes[field.key] = value ?? '';
    });
  const delivery = {};
  ['inPerson', 'shipping', 'pickup', 'agreed'].forEach((option) => {
    delivery[option] = category.deliveryOptions.includes(option) && Boolean(data.delivery?.[option]);
  });
  return {
    title: (data.title ?? '').trim(),
    description: (data.description ?? '').trim(),
    category: category.id,
    subcategory: category.subcategoryField ? attributes[category.subcategoryField] || null : null,
    operationType: data.operationType ?? category.operations[0],
    price: data.price === '' || data.price === null || data.price === undefined ? null : Number(data.price),
    currency: APP_CONFIG.currency,
    rental: data.operationType === 'rent'
      ? {
        period: data.rental?.period ?? null,
        minDuration: data.rental?.minDuration ? Number(data.rental.minDuration) : 1,
        maxDuration: data.rental?.maxDuration ? Number(data.rental.maxDuration) : null,
        requirements: (data.rental?.requirements ?? '').trim(),
      }
      : null,
    condition: category.basic.condition ? data.condition || null : null,
    brand: category.basic.brand ? (data.brand ?? '').trim() : '',
    model: category.basic.model ? (data.model ?? '').trim() : '',
    availability: (data.availability ?? '').trim(),
    deliveryNotes: (data.deliveryNotes ?? '').trim(),
    attributes,
    customAttributes: category.allowCustomAttributes
      ? (data.customAttributes ?? []).filter((item) => item.label?.trim() && item.value?.trim()).map((item) => ({ label: item.label.trim(), value: item.value.trim() }))
      : [],
    images: (data.images ?? []).map((image, index) => ({ id: image.id, src: image.src, alt: image.alt || `${data.title} — imagen ${index + 1}` })),
    location: {
      city: (data.location?.city ?? '').trim(),
      postalCode: (data.location?.postalCode ?? '').trim(),
      zone: (data.location?.zone ?? '').trim(),
    },
    delivery,
  };
}
