/**
 * ui.js
 * ---------------------------------------------------------------------------
 * Componentes de interfaz reutilizables: tarjetas de anuncio, avisos (toasts),
 * ventanas modales accesibles, confirmaciones, campos de formulario, estados
 * vacíos, insignias, avatares y valoraciones.
 */

import { ApiError } from './api.js';
import { getCategory, LISTING_STATUS, OPERATION_LABELS, ORDER_STATUS, RENTAL_PERIODS, ITEM_CONDITIONS } from './data.js';
import { icon } from './icons.js';
import { actions, select } from './store.js';
import { escapeHtml, formatMoney, initials, timeAgo } from './utils.js';

/* ==========================================================================
   Utilidades DOM
   ========================================================================== */

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * Navega a una ruta hash. Si ya estamos en ella, fuerza el repintado
 * disparando el evento hashchange que escucha el enrutador (app.js).
 */
export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

/** Id de elemento seguro a partir de una ruta de campo («location.city» → «f-location-city»). */
export const fieldId = (name) => `f-${String(name).replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/**
 * Marca un botón como "ocupado" mientras dura una operación asíncrona.
 * Evita pulsaciones repetidas (p. ej. pedidos duplicados).
 */
export async function withBusy(button, task) {
  if (button?.dataset.busy === 'true') return undefined;
  const originalHtml = button?.innerHTML;
  if (button) {
    button.dataset.busy = 'true';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(button.textContent.trim())}</span>`;
  }
  try {
    return await task();
  } finally {
    if (button && button.isConnected) {
      button.dataset.busy = 'false';
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.innerHTML = originalHtml;
    }
  }
}

/* ==========================================================================
   Avisos (toasts)
   ========================================================================== */

export function toast(message, { tone = 'success', timeout = 4200 } = {}) {
  const region = qs('#toast-region');
  const element = document.createElement('div');
  element.className = `toast toast--${tone}`;
  element.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  const iconName = { success: 'check', error: 'alert', info: 'info', warning: 'alert' }[tone] ?? 'info';
  element.innerHTML = `${icon(iconName)}<p>${escapeHtml(message)}</p><button type="button" class="icon-btn icon-btn--sm" aria-label="Cerrar aviso">${icon('x')}</button>`;
  element.querySelector('button').addEventListener('click', () => element.remove());
  region.append(element);
  setTimeout(() => element.classList.add('toast--leaving'), timeout);
  setTimeout(() => element.remove(), timeout + 300);
}

let authRequiredHandler = null;

/** Registra qué hacer cuando la API pide iniciar sesión (auth.js abre el cuadro de acceso). */
export function setAuthRequiredHandler(handler) {
  authRequiredHandler = handler;
}

/** Muestra un error de la API (mensaje de negocio) o uno genérico si es inesperado. */
export function handleError(error) {
  if (error instanceof ApiError && error.code === 'auth_required' && authRequiredHandler) {
    authRequiredHandler(error.message);
  } else if (error instanceof ApiError) {
    toast(error.message, { tone: 'error', timeout: 6000 });
  } else {
    console.error(error);
    toast('Se ha producido un error inesperado. Inténtalo de nuevo.', { tone: 'error' });
  }
}

/* ==========================================================================
   Ventanas modales accesibles
   ========================================================================== */

let modalCounter = 0;

/**
 * Abre una ventana modal. Gestiona el foco (lo atrapa dentro y lo devuelve
 * al cerrar), la tecla Escape y el clic fuera del contenido.
 * @returns {{ element: HTMLElement, close: Function }}
 */
export function openModal({ title, body, footer = '', size = 'md', lead = '', onClose } = {}) {
  const previouslyFocused = document.activeElement;
  const titleId = `modal-title-${++modalCounter}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal modal--${size}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <header class="modal__header">
        ${lead ? `<div class="modal__lead">${lead}</div>` : ''}
        <h2 id="${titleId}" class="modal__title">${escapeHtml(title)}</h2>
        <button type="button" class="icon-btn" data-modal-close aria-label="Cerrar">${icon('x')}</button>
      </header>
      <div class="modal__body">${body}</div>
      ${footer ? `<footer class="modal__footer">${footer}</footer>` : ''}
    </div>`;

  const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKeydown);
    if (!qs('.modal-backdrop')) document.body.classList.remove('has-modal');
    previouslyFocused?.focus?.();
    onClose?.();
  };
  const onKeydown = (event) => {
    if (backdrop !== qsa('.modal-backdrop').at(-1)) return;
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') {
      const focusable = qsa(focusableSelector, backdrop);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };

  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(); });
  qsa('[data-modal-close]', backdrop).forEach((button) => button.addEventListener('click', close));
  document.addEventListener('keydown', onKeydown);
  document.body.append(backdrop);
  document.body.classList.add('has-modal');
  const autofocus = qs('[autofocus]', backdrop) ?? qsa(focusableSelector, qs('.modal__body', backdrop))[0] ?? qs('[data-modal-close]', backdrop);
  autofocus?.focus();
  return { element: backdrop, close };
}

/** Diálogo de confirmación. Devuelve una promesa que se resuelve con true/false. */
export function confirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let confirmed = false;
    const { element, close } = openModal({
      title,
      size: 'sm',
      body: `<p>${escapeHtml(message)}</p>`,
      footer: `
        <button type="button" class="btn btn--ghost" data-modal-close>Cancelar</button>
        <button type="button" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-confirm>${escapeHtml(confirmLabel)}</button>`,
      onClose: () => resolve(confirmed),
    });
    const confirmButton = qs('[data-confirm]', element);
    confirmButton.focus();
    confirmButton.addEventListener('click', () => { confirmed = true; close(); });
  });
}

/* ==========================================================================
   Emblemas de la guía de estilo
   ========================================================================== */

/** Sello de la marca: «L» en rojo lacre dentro de un marco doble dorado. */
export const SEAL_EMBLEM = `<svg class="auth-emblem" viewBox="0 0 40 44" aria-hidden="true"><rect x="1" y="1" width="38" height="42" fill="#FBF5E6" stroke="#C9A86A" stroke-width="2"/><rect x="4.5" y="4.5" width="31" height="35" fill="none" stroke="#C9A86A" stroke-width="0.8"/><path d="M8 36c5-2.5 9-1 13 0s8 1.5 11-1" fill="none" stroke="#C9A86A" stroke-width="1"/><path d="M30 8l2 2-2 2-2-2z" fill="#C9A86A"/><text x="19" y="31" text-anchor="middle" font-family="IM Fell English SC, Georgia, serif" font-size="30" fill="#7A2E1F">L</text></svg>`;

/** Balanza de la lonja (bienvenida y estados vacíos). */
export function scalesEmblem(className = '') {
  return `<svg class="${className}" viewBox="0 0 120 96" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M60 16v64M44 86h32M50 80h20M22 24h76M28 24 16 54M28 24l12 30M92 24 80 54M92 24l12 30M12 54c0 9 32 9 32 0zM76 54c0 9 32 9 32 0z"/><circle cx="60" cy="12" r="3.5"/><path d="M17 57l3 3M23 58l3 3M29 58l3 3M35 57l3 2M81 57l3 3M87 58l3 3M93 58l3 3M99 57l3 2M56 34h8M56 44h8M56 54h8M56 64h8" stroke-width="0.7"/></svg>`;
}

/** Separador de época: filete punteado (o doble) con un rombo dorado en el centro. */
export function ornamentRule(variant = '') {
  return `<div class="ornament-rule ${variant ? `ornament-rule--${variant}` : ''}" aria-hidden="true"><span></span><i></i><span></span></div>`;
}

/* ==========================================================================
   Piezas visuales pequeñas
   ========================================================================== */

export function badge(label, tone = 'neutral', extraClass = '') {
  return `<span class="badge badge--${tone} ${extraClass}">${escapeHtml(label)}</span>`;
}

export function listingStatusBadge(status) {
  const info = LISTING_STATUS[status] ?? { label: status, tone: 'neutral' };
  return badge(info.label, info.tone);
}

export function orderStatusBadge(order) {
  const info = ORDER_STATUS[order.operationType]?.[order.status] ?? { label: order.status, tone: 'neutral' };
  return badge(info.label, info.tone);
}

/** true si los datos se guardan en la base de datos compartida (Neon); false si solo en este navegador. */
export const usesDatabase = () => select.dataSource() === 'neon';

/** Etiqueta «Requiere backend» para funciones que no pueden ser reales en esta versión. */
export function backendBadge(text = 'Requiere backend') {
  return `<span class="badge badge--backend" title="Esta función necesita un servidor y no está operativa en la demostración">${icon('lock')}${escapeHtml(text)}</span>`;
}

/** Precio con sufijo de periodo para alquileres (p. ej. «45 €/día»). */
export function priceLabel(listing) {
  const suffix = listing.operationType === 'rent' ? RENTAL_PERIODS[listing.rental?.period]?.suffix ?? '' : '';
  return `${formatMoney(listing.price)}${suffix ? `<small>${suffix}</small>` : ''}`;
}

const AVATAR_HUES = [215, 262, 340, 160, 28, 190, 120];

/** Avatar del usuario: foto si existe o iniciales sobre un color estable. */
export function avatar(user, size = 'md') {
  if (!user) return `<span class="avatar avatar--${size}" aria-hidden="true">?</span>`;
  if (user === 'guest') return `<span class="avatar avatar--${size} avatar--guest" aria-hidden="true">${icon('user')}</span>`;
  if (user.avatar) return `<img class="avatar avatar--${size}" src="${escapeHtml(user.avatar)}" alt="" />`;
  const hue = AVATAR_HUES[[...user.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % AVATAR_HUES.length];
  return `<span class="avatar avatar--${size}" style="--avatar-hue:${hue}" aria-hidden="true">${escapeHtml(initials(user.displayName))}</span>`;
}

/** Estrellas de valoración (solo lectura). */
export function stars(rating, { showValue = true } = {}) {
  if (rating === null || rating === undefined) return '<span class="muted">Sin valoraciones</span>';
  const rounded = Math.round(rating);
  const starsHtml = Array.from({ length: 5 }, (_, index) => `<span class="star ${index < rounded ? 'star--on' : ''}">${icon('star')}</span>`).join('');
  return `<span class="stars" role="img" aria-label="${rating.toFixed(1)} de 5 estrellas">${starsHtml}${showValue ? `<span class="stars__value">${rating.toFixed(1)}</span>` : ''}</span>`;
}

/** Estado vacío con icono, texto y acción opcional. */
export function emptyState({ iconName = 'search', title, text = '', action = '', emblem = false }) {
  return `
    <div class="empty-state">
      ${emblem ? scalesEmblem('empty-state__emblem') : `<div class="empty-state__icon">${icon(iconName)}</div>`}
      <h3>${escapeHtml(title)}</h3>
      ${text ? `<p>${escapeHtml(text)}</p>` : ''}
      ${action}
    </div>`;
}

/** Aviso informativo en línea (p. ej. para indicar que algo es una demostración). */
export function notice(html, tone = 'info') {
  return `<div class="notice notice--${tone}">${icon(tone === 'warning' ? 'alert' : 'info')}<div>${html}</div></div>`;
}

export function loadingBlock(text = 'Cargando…') {
  return `<div class="loading-block" role="status"><span class="spinner spinner--lg" aria-hidden="true"></span><span>${escapeHtml(text)}</span></div>`;
}

/* ==========================================================================
   Tarjeta de anuncio
   ========================================================================== */

/** Valoración media con coma decimal («4,8»). */
export function formatRating(average) {
  return average === null || average === undefined ? '' : average.toFixed(1).replace('.', ',');
}

/**
 * Etiquetas sobre la foto: estado del anuncio (Vendido, Pausado… en tinta),
 * Reservado (oro viejo) si tiene un pedido abierto, y Alquiler.
 */
function cardTags(listing) {
  const tags = [];
  if (listing.status !== 'active') tags.push(`<span class="tag tag--ink">${escapeHtml(LISTING_STATUS[listing.status]?.label ?? listing.status)}</span>`);
  else if (listing.operationType === 'sale' && select.openSaleOrder(listing.id)) tags.push('<span class="tag tag--gold">Reservado</span>');
  if (listing.operationType === 'rent') tags.push(`<span class="tag tag--outline">${OPERATION_LABELS.rent}</span>`);
  return tags.length ? `<div class="listing-card__tags">${tags.join('')}</div>` : '';
}

/**
 * Tarjeta de anuncio (guía de estilo, apartado VI): foto, precio en rojo
 * lacre, título, ubicación y, tras un filete punteado, vendedor y valoración.
 * Los anuncios destacados llevan marco doble dorado y la etiqueta «Destacado».
 */
export function listingCard(listing, { showPriceChangeSince = null, featured = false } = {}) {
  const category = getCategory(listing.category);
  const seller = select.user(listing.sellerId);
  const isOwn = listing.sellerId === select.currentUserId();
  const isFav = select.isFavorite(listing.id);
  const mainImage = listing.images?.[0];
  const priceChange = showPriceChangeSince ? select.priceChangeSince(listing, showPriceChangeSince) : null;
  const title = escapeHtml(listing.title);
  const showRating = seller?.preferences?.privacy?.showRating !== false;
  const rating = seller && showRating ? select.ratingSummary(seller.id) : null;
  const isFeatured = featured && listing.featured;

  return `
    <article class="listing-card ${isFeatured ? 'listing-card--featured' : ''} ${listing.status !== 'active' ? 'listing-card--inactive' : ''}" data-listing-id="${listing.id}">
      <div class="listing-card__media">
        ${mainImage
          ? `<img src="${escapeHtml(mainImage.src)}" alt="${escapeHtml(mainImage.alt || listing.title)}" loading="lazy" />`
          : `<div class="listing-card__noimg">${icon(category?.icon ?? 'image')}<span>Sin foto · ${escapeHtml(category?.shortName ?? '')}</span></div>`}
        ${cardTags(listing)}
        ${isFeatured ? '<span class="tag tag--featured listing-card__featured">Destacado</span>' : ''}
        ${isOwn
          ? '<span class="tag tag--ink listing-card__own">Tu anuncio</span>'
          : `<button type="button" class="fav-btn ${isFav ? 'is-active' : ''}" data-action="toggle-favorite" data-listing-id="${listing.id}"
              aria-pressed="${isFav}" aria-label="${isFav ? 'Quitar de favoritos' : 'Guardar en favoritos'}: ${title}">${icon('heart')}</button>`}
      </div>
      <div class="listing-card__body">
        <p class="listing-card__price">${priceLabel(listing)}</p>
        ${priceChange ? `<p class="price-change ${priceChange.difference < 0 ? 'price-change--down' : 'price-change--up'}">${priceChange.difference < 0 ? 'Ha bajado' : 'Ha subido'} desde ${formatMoney(priceChange.from)}</p>` : ''}
        <h3 class="listing-card__title"><a href="#/listing/${listing.id}" class="stretched-link">${title}</a></h3>
        <p class="listing-card__meta">${icon('pin', 'icon--xs')}<span>${escapeHtml(listing.location.city)}</span></p>
        <div class="listing-card__footer">
          <span class="listing-card__seller">${avatar(seller, 'xs')}<span>${escapeHtml(seller?.displayName ?? 'Usuario')}</span></span>
          ${rating?.average ? `<span class="listing-card__rating" role="img" aria-label="Valoración ${formatRating(rating.average)} de 5">${icon('star')}${formatRating(rating.average)}</span>` : ''}
        </div>
      </div>
    </article>`;
}

/**
 * Rejilla de tarjetas. columns: 4 para las filas del inicio (en móvil pasan a
 * una fila con desplazamiento horizontal).
 */
export function listingGrid(listings, { emptyTitle = 'No hay anuncios', emptyText = '', emptyAction = '', cardOptions, columns = 0, emblem = false } = {}) {
  if (!listings.length) return emptyState({ iconName: 'search', title: emptyTitle, text: emptyText, action: emptyAction, emblem });
  return `<div class="listing-grid ${columns ? `listing-grid--${columns}` : ''}">${listings.map((listing) => listingCard(listing, cardOptions)).join('')}</div>`;
}

/** Miniatura + título de un anuncio (para tablas de pedidos, mensajes…). */
export function listingMini(listing) {
  if (!listing) return '<span class="muted">Anuncio no disponible</span>';
  const image = listing.images?.[0];
  return `
    <span class="listing-mini">
      ${image ? `<img src="${escapeHtml(image.src)}" alt="" />` : `<span class="listing-mini__noimg">${icon('image')}</span>`}
      <span class="listing-mini__text">
        ${listing.deletedAt ? `<span>${escapeHtml(listing.title)}</span><small class="muted">Anuncio eliminado</small>` : `<a href="#/listing/${listing.id}">${escapeHtml(listing.title)}</a>`}
      </span>
    </span>`;
}

/* ==========================================================================
   Formateo de atributos y campos de formulario
   ========================================================================== */

export function conditionLabel(value) {
  return ITEM_CONDITIONS.find(([key]) => key === value)?.[1] ?? '';
}

/** Valor legible de un atributo según la definición del campo. */
export function formatAttribute(field, value) {
  if (field.type === 'checkbox') return value ? 'Sí' : 'No';
  if (value === null || value === undefined || value === '') return null;
  if (field.type === 'select') return field.options.find(([key]) => key === String(value))?.[1] ?? String(value);
  if (field.type === 'number') {
    if (field.unit === '€') return formatMoney(value);
    return `${Number(value).toLocaleString('es-ES')}${field.unit ? ` ${field.unit}` : ''}`;
  }
  if (field.type === 'date') return new Date(`${value}T00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  return String(value);
}

/**
 * Genera el marcado accesible de un campo de formulario: etiqueta asociada,
 * texto de ayuda, mensaje de error con aria-describedby y aria-invalid.
 */
export function renderField({ name, label, type = 'text', value = '', error = '', options = [], required = false, help = '', placeholder = '', unit = '', min, max, maxLength, rows = 4, disabled = false, autocomplete = '', emptyOption = 'Selecciona…' }) {
  const id = fieldId(name);
  const describedBy = [help ? `${id}-help` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  const common = `id="${id}" name="${escapeHtml(name)}" ${required ? 'required aria-required="true"' : ''} ${error ? 'aria-invalid="true"' : ''} ${describedBy ? `aria-describedby="${describedBy}"` : ''} ${disabled ? 'disabled' : ''}`;
  const safeValue = escapeHtml(value ?? '');
  let control;

  if (type === 'checkbox') {
    return `
      <div class="field field--checkbox ${error ? 'has-error' : ''}">
        <label class="checkbox" for="${id}">
          <input type="checkbox" ${common} ${value ? 'checked' : ''} />
          <span>${escapeHtml(label)}</span>
        </label>
        ${help ? `<p class="field__help" id="${id}-help">${escapeHtml(help)}</p>` : ''}
        ${error ? `<p class="field__error" id="${id}-error">${icon('alert', 'icon--xs')}${escapeHtml(error)}</p>` : ''}
      </div>`;
  }

  if (type === 'select') {
    control = `<select ${common}>
      <option value="">${escapeHtml(emptyOption)}</option>
      ${options.map(([optionValue, optionLabel]) => `<option value="${escapeHtml(optionValue)}" ${String(value) === String(optionValue) ? 'selected' : ''}>${escapeHtml(optionLabel)}</option>`).join('')}
    </select>`;
  } else if (type === 'textarea') {
    control = `<textarea ${common} rows="${rows}" ${maxLength ? `maxlength="${maxLength}"` : ''} placeholder="${escapeHtml(placeholder)}">${safeValue}</textarea>`;
  } else {
    const inputMode = type === 'number' ? 'inputmode="decimal"' : '';
    control = `<input type="${type}" ${common} value="${safeValue}" ${inputMode} ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} ${maxLength ? `maxlength="${maxLength}"` : ''} ${placeholder ? `placeholder="${escapeHtml(placeholder)}"` : ''} ${autocomplete ? `autocomplete="${autocomplete}"` : ''} />`;
  }

  return `
    <div class="field ${error ? 'has-error' : ''}">
      <label class="field__label" for="${id}">${escapeHtml(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
      ${unit ? `<div class="input-unit">${control}<span class="input-unit__suffix">${escapeHtml(unit)}</span></div>` : control}
      ${help ? `<p class="field__help" id="${id}-help">${escapeHtml(help)}</p>` : ''}
      ${error ? `<p class="field__error" id="${id}-error">${icon('alert', 'icon--xs')}${escapeHtml(error)}</p>` : ''}
    </div>`;
}

/** Muestra u oculta errores en un formulario ya renderizado (sin volver a pintarlo). */
export function showFormErrors(form, errors) {
  qsa('.field__error[data-dynamic]', form).forEach((element) => element.remove());
  qsa('[aria-invalid="true"]', form).forEach((element) => element.removeAttribute('aria-invalid'));
  qsa('.has-error', form).forEach((element) => element.classList.remove('has-error'));
  Object.entries(errors).forEach(([name, message]) => {
    const input = form.elements.namedItem(name);
    if (!input || !input.closest) return;
    const field = input.closest('.field');
    field?.classList.add('has-error');
    input.setAttribute('aria-invalid', 'true');
    const errorId = `${input.id}-error`;
    const error = document.createElement('p');
    error.className = 'field__error';
    error.id = errorId;
    error.dataset.dynamic = 'true';
    error.innerHTML = `${icon('alert', 'icon--xs')}${escapeHtml(message)}`;
    field?.append(error);
    input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), errorId].filter(Boolean).join(' '));
  });
  const firstInvalid = qs('[aria-invalid="true"]', form);
  firstInvalid?.focus();
  return !firstInvalid;
}

/** Línea de tiempo con el historial de estados de un pedido. */
export function orderTimeline(order) {
  const labels = ORDER_STATUS[order.operationType];
  return `<ol class="timeline">${order.statusHistory.map((entry) => {
    const user = select.user(entry.by);
    return `<li class="timeline__item"><span class="timeline__dot"></span><div><strong>${escapeHtml(labels[entry.status]?.label ?? entry.status)}</strong><small class="muted"> · ${timeAgo(entry.date)} · ${escapeHtml(user?.displayName ?? '')}</small></div></li>`;
  }).join('')}</ol>`;
}

/** Componente de cabecera de sección del panel. */
export function sectionHeader(title, subtitle = '', actionsHtml = '') {
  return `
    <header class="section-header">
      <div>
        <h1 class="section-header__title">${escapeHtml(title)}</h1>
        ${subtitle ? `<p class="section-header__subtitle">${escapeHtml(subtitle)}</p>` : ''}
      </div>
      ${actionsHtml ? `<div class="section-header__actions">${actionsHtml}</div>` : ''}
    </header>`;
}

/** Tarjeta de estadística del panel. */
export function statCard({ label, value, iconName, hint = '', tone = 'primary', href = '' }) {
  const inner = `
    <span class="stat-card__icon stat-card__icon--${tone}">${icon(iconName)}</span>
    <span class="stat-card__value">${value}</span>
    <span class="stat-card__label">${escapeHtml(label)}</span>
    ${hint ? `<span class="stat-card__hint">${escapeHtml(hint)}</span>` : ''}`;
  return href ? `<a class="stat-card stat-card--link" href="${href}">${inner}</a>` : `<div class="stat-card">${inner}</div>`;
}

/** Barra lateral de navegación para los paneles (vendedor, comprador, ajustes). */
export function panelSidebar({ title, items, activeId, ariaLabel }) {
  return `
    <nav class="panel-nav" aria-label="${escapeHtml(ariaLabel ?? title)}">
      <p class="panel-nav__title">${escapeHtml(title)}</p>
      <ul>
        ${items.map((item) => `
          <li><a href="${item.href}" class="panel-nav__link ${item.id === activeId ? 'is-active' : ''}" ${item.id === activeId ? 'aria-current="page"' : ''}>
            ${icon(item.icon)}<span>${escapeHtml(item.label)}</span>${item.count ? `<span class="count-pill">${item.count}</span>` : ''}
          </a></li>`).join('')}
      </ul>
    </nav>`;
}

/** Pestañas de filtro (botones con aria-pressed). */
export function filterTabs(tabs, activeId, ariaLabel) {
  return `<div class="filter-tabs" role="group" aria-label="${escapeHtml(ariaLabel)}">
    ${tabs.map((tab) => `<button type="button" class="filter-tab ${tab.id === activeId ? 'is-active' : ''}" data-filter="${tab.id}" aria-pressed="${tab.id === activeId}">${escapeHtml(tab.label)}${tab.count !== undefined ? ` <span class="filter-tab__count">${tab.count}</span>` : ''}</button>`).join('')}
  </div>`;
}

/* ==========================================================================
   Denuncias y avisos de problemas
   ========================================================================== */

/** Formulario para denunciar un anuncio o comunicar un problema. */
export function openReportDialog(listing = null) {
  const { element, close } = openModal({
    title: listing ? 'Denunciar anuncio' : 'Comunicar un problema',
    body: `
      <form id="report-form" novalidate>
        ${notice(usesDatabase()
          ? 'La denuncia se guarda en la base de datos. Todavía no hay un equipo de moderación que la revise.'
          : 'La denuncia se registra únicamente en este navegador. La revisión por un equipo de moderación requiere backend.')}
        ${listing ? `<p>Anuncio: <strong>${escapeHtml(listing.title)}</strong></p>` : ''}
        ${renderField({ name: 'reason', label: 'Motivo', type: 'select', required: true, options: listing
          ? [['fraud', 'Posible fraude o estafa'], ['prohibited', 'Artículo prohibido'], ['wrong_category', 'Categoría incorrecta'], ['offensive', 'Contenido ofensivo'], ['duplicate', 'Anuncio duplicado'], ['other', 'Otro motivo']]
          : [['bug', 'Error de la aplicación'], ['account', 'Problema con mi cuenta'], ['order', 'Problema con un pedido'], ['other', 'Otro']] })}
        ${renderField({ name: 'details', label: 'Describe el problema', type: 'textarea', required: true, maxLength: 1000, help: 'Mínimo 10 caracteres.' })}
      </form>`,
    footer: '<button type="button" class="btn btn--ghost" data-modal-close>Cancelar</button><button type="submit" form="report-form" class="btn btn--primary">Enviar</button>',
  });
  const form = qs('#report-form', element);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    const errors = {};
    if (!values.reason) errors.reason = 'Selecciona un motivo.';
    if ((values.details ?? '').trim().length < 10) errors.details = 'Describe el problema con al menos 10 caracteres.';
    if (!showFormErrors(form, errors)) return;
    await withBusy(qs('button[type="submit"]', element), async () => {
      try {
        await actions.createReport({ type: listing ? 'listing' : 'problem', listingId: listing?.id ?? null, ...values });
        close();
        toast(usesDatabase() ? 'Gracias. Hemos registrado tu aviso.' : 'Gracias. Hemos registrado tu aviso (solo en este navegador).');
      } catch (error) { handleError(error); }
    });
  });
}
