/**
 * app.js
 * ---------------------------------------------------------------------------
 * Punto de entrada de la aplicación:
 *  - arranque (sprite de iconos, carga de datos);
 *  - enrutado por hash (#/ruta?parametros) sin recargar la página;
 *  - cabecera persistente y menú de usuario;
 *  - vistas públicas: inicio, explorar/buscar, categorías, detalle de
 *    anuncio y perfil público.
 *
 * El aspecto sigue la guía de estilo de LONJA (pergamino, rojo lacre,
 * versalitas y filetes de libro de cuentas): ver styles.css.
 *
 * Los paneles de vendedor, comprador y ajustes viven en seller.js, buyer.js
 * y profile.js respectivamente.
 */

import { APP_CONFIG, CATEGORIES, DELIVERY_METHODS, getCategory, ITEM_CONDITIONS, LISTING_STATUS, OPERATION_LABELS, RENTAL_PERIODS, VERTICALS } from './data.js';
import { icon, injectIconSprite } from './icons.js';
import { actions, initStore, select, subscribe } from './store.js';
import {
  avatar, badge, conditionLabel, confirmDialog, emptyState, formatAttribute, formatRating, handleError, listingGrid,
  listingStatusBadge, navigate, notice, openReportDialog, ornamentRule, priceLabel, qs, qsa, renderField, scalesEmblem, stars, toast, withBusy,
} from './ui.js';
import { debounce, escapeHtml, formatDate, formatMoney, replaceHash, safeStorage, timeAgo } from './utils.js';
import { isFieldVisible } from './validation.js';
import { renderSellerPanel } from './seller.js';
import { openPurchaseDialog, renderBuyerPanel } from './buyer.js';
import { renderSettings } from './profile.js';
import { logout, openAuthDialog, promptLoginOnFirstVisit, requireLogin } from './auth.js';

/* ==========================================================================
   Enrutado
   ========================================================================== */

const viewContainer = () => qs('#view');
let currentView = null;
let isFirstRender = true;

/** Lee la ruta actual del hash: «#/seller/listings?status=active». */
export function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?');
  return { path, segments: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
}

/** Tabla de rutas → función que dibuja la vista y la entrada del menú que se resalta. */
function resolveRoute({ segments, params }) {
  const [first = 'home', second, third] = segments;
  switch (first) {
    case 'home': return { nav: 'home', title: 'Inicio', render: (el) => renderHome(el) };
    case 'explore': return { nav: 'explore', title: 'Explorar anuncios', render: (el) => renderExplore(el, params, {}) };
    case 'vehicles': return { nav: 'vehicles', title: 'Vehículos', render: (el) => renderExplore(el, params, { vertical: 'vehicles' }) };
    case 'housing': return { nav: 'housing', title: 'Viviendas', render: (el) => renderExplore(el, params, { vertical: 'realestate' }) };
    case 'rentals': return { nav: 'rentals', title: 'Alquileres', render: (el) => renderExplore(el, params, { op: 'rent' }) };
    case 'categories': return { nav: 'categories', title: 'Categorías', render: (el) => renderCategories(el) };
    case 'listing': return { nav: 'listing', title: 'Anuncio', render: (el) => renderListingDetail(el, second) };
    case 'user': return { nav: second === select.currentUserId() ? 'profile' : 'explore', title: 'Perfil', render: (el) => renderPublicProfile(el, second) };
    case 'profile': return { nav: 'profile', title: 'Mi perfil', auth: true, render: (el) => renderPublicProfile(el, select.currentUserId()) };
    case 'favorites': return { nav: 'favorites', title: 'Favoritos', auth: true, render: (el) => renderBuyerPanel(el, 'favorites', params) };
    case 'purchases': return { nav: 'purchases', title: 'Mis compras', auth: true, render: (el) => renderBuyerPanel(el, 'orders', params) };
    case 'buyer': return {
      nav: second === 'favorites' ? 'favorites' : second === 'messages' ? 'messages' : 'purchases',
      title: second === 'messages' ? 'Mensajes' : 'Panel de comprador', auth: true, render: (el) => renderBuyerPanel(el, second ?? 'overview', params),
    };
    case 'sell': return { nav: 'sell', title: 'Publicar anuncio', auth: true, render: (el) => renderSellerPanel(el, 'new', null, params) };
    case 'seller': return { nav: 'sell', title: 'Panel de vendedor', auth: true, render: (el) => renderSellerPanel(el, second ?? 'overview', third, params) };
    // La ayuda (condiciones, privacidad, preguntas frecuentes) es pública; el resto de ajustes, no.
    case 'settings': return { nav: 'settings', title: second === 'help' ? 'Ayuda' : 'Ajustes', auth: second !== 'help', render: (el) => renderSettings(el, second ?? 'personal', params) };
    default: return { nav: '', title: 'Página no encontrada', render: (el) => renderNotFound(el) };
  }
}

/** Dibuja la vista de la ruta actual. authChange: se ha entrado, salido o cambiado de cuenta. */
function route({ authChange = false } = {}) {
  const routeInfo = parseRoute();
  const resolved = resolveRoute(routeInfo);
  closeMenus();
  currentView?.destroy?.();
  currentView = null;
  document.body.classList.remove('has-action-bar');
  document.body.dataset.view = resolved.nav || 'other';
  const container = viewContainer();
  container.classList.remove('view--enter');
  void container.offsetWidth; // reinicia la animación de entrada
  container.classList.add('view--enter');
  try {
    if (resolved.auth && select.isGuest()) {
      // Invitado en una sección privada: se explica y se ofrece entrar o registrarse.
      currentView = renderLoginRequired(container, resolved.title);
      if (!isFirstRender && !authChange) openAuthDialog({ reason: `Inicia sesión o crea una cuenta para acceder a «${resolved.title}».` });
    } else {
      currentView = resolved.render(container) ?? null;
    }
  } catch (error) {
    console.error(error);
    container.innerHTML = `<div class="container page">${emptyState({ iconName: 'alert', title: 'No se pudo mostrar esta sección', text: 'Se ha producido un error inesperado.' })}</div>`;
    currentView = null;
  }
  document.title = `${resolved.title} · ${APP_CONFIG.brandName.toUpperCase()}`;
  highlightNav(resolved.nav);
  if (!isFirstRender && !authChange && !routeInfo.params.has('keepScroll')) {
    window.scrollTo({ top: 0 });
    qs('#main').focus({ preventScroll: true });
  }
  isFirstRender = false;
}

/** Sección privada vista por un invitado. */
function renderLoginRequired(container, title) {
  container.innerHTML = `
    <div class="container page">
      ${emptyState({
        iconName: 'lock',
        title: 'Inicia sesión para continuar',
        text: `«${title}» solo está disponible con una cuenta. Como invitado puedes ver anuncios, categorías y perfiles públicos.`,
        action: `<div class="empty-state__actions">
          <button type="button" class="btn btn--primary" data-auth-open="login">${icon('login')}Iniciar sesión</button>
          <button type="button" class="btn btn--ghost" data-auth-open="register">${icon('userPlus')}Crear cuenta</button>
        </div>`,
      })}
    </div>`;
  return null;
}

/** Secciones que comparten pestaña en la barra inferior del móvil. */
const NAV_ALIASES = {
  purchases: 'account', profile: 'account', settings: 'account', favorites: 'account',
  categories: 'explore', vehicles: 'explore', housing: 'explore', rentals: 'explore', listing: 'explore',
};

function highlightNav(navId) {
  const alias = NAV_ALIASES[navId];
  qsa('[data-nav]').forEach((link) => {
    const isActive = link.dataset.nav === navId || link.dataset.nav === alias;
    link.classList.toggle('is-active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

/* ==========================================================================
   Cabecera y menú de usuario
   ========================================================================== */

function setupHeader() {
  // Búsqueda: navega a Explorar con el texto escrito.
  const searchForm = qs('#header-search');
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = searchForm.elements.q.value.trim();
    navigate(`#/explore${query ? `?${new URLSearchParams({ q: query })}` : ''}`);
  });

  // Menú desplegable de usuario («Acceder» si es un invitado)
  const trigger = qs('#user-menu-trigger');
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    const panel = qs('#user-menu-panel');
    const open = panel.hidden;
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) qs('a, button, select', panel)?.focus();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#user-menu')) closeUserMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !qs('#user-menu-panel').hidden) { closeUserMenu(); trigger.focus(); }
  });
}

function closeUserMenu() {
  qs('#user-menu-panel').hidden = true;
  qs('#user-menu-trigger').setAttribute('aria-expanded', 'false');
}

function closeMenus() {
  closeUserMenu();
}

/** Selector de cuentas de prueba (entrar en ellas no pide contraseña). */
function demoSwitcher(user) {
  const demoUsers = select.demoUsers();
  if (!demoUsers.length) return '';
  const currentIsDemo = demoUsers.some((candidate) => candidate.id === user?.id);
  return `
    <div class="user-menu__demo">
      <label for="demo-user-switch">Cuenta de demostración</label>
      <select id="demo-user-switch">
        ${currentIsDemo ? '' : '<option value="" selected>Elige una cuenta de prueba…</option>'}
        ${demoUsers.map((candidate) => `<option value="${candidate.id}" ${candidate.id === user?.id ? 'selected' : ''}>${escapeHtml(candidate.displayName)} (@${escapeHtml(candidate.username)})</option>`).join('')}
      </select>
      <p class="field__help">Cambia de usuario para probar la compra y la venta entre cuentas. Las cuentas que crees tú piden su contraseña.</p>
    </div>`;
}

/** Actualiza el botón de cuenta, el menú de usuario y los contadores de la cabecera. */
function updateHeader() {
  const user = select.currentUser();
  const stats = user ? select.buyerStats(user.id) : null;
  const sellerPending = user ? select.sellerStats(user.id).pendingOrders : 0;
  const trigger = qs('#user-menu-trigger');
  trigger.classList.toggle('is-guest', !user);
  qs('#user-menu-avatar').innerHTML = user ? avatar(user, 'sm') : 'Acceder';
  qs('#user-menu-trigger .visually-hidden').textContent = user ? `Menú de tu cuenta (${user.displayName})` : ': iniciar sesión o crear una cuenta';
  const setCount = (name, value) => {
    const dot = qs(`[data-count="${name}"]`);
    if (!dot) return;
    dot.hidden = !value;
    dot.textContent = value > 9 ? '9+' : String(value);
  };
  setCount('favorites', stats?.favorites ?? 0);
  setCount('messages', stats?.unreadMessages ?? 0);
  setCount('messages-mobile', stats?.unreadMessages ?? 0);
  qs('.header-actions__messages').setAttribute('aria-label', stats?.unreadMessages ? `Mensajes, ${stats.unreadMessages} sin leer` : 'Mensajes');

  const panel = qs('#user-menu-panel');
  const wasOpen = !panel.hidden;
  // Con la base de datos compartida no se pueden restablecer los datos desde la web.
  const resetItem = select.canResetDemo() ? `<li><button type="button" id="reset-demo">${icon('refresh')}Restablecer datos de prueba</button></li>` : '';

  if (!user) {
    panel.innerHTML = `
      <div class="user-menu__header">
        ${avatar('guest', 'md')}
        <div><strong>Invitado</strong><small>No has iniciado sesión</small></div>
      </div>
      <div class="user-menu__auth">
        <button type="button" class="btn btn--primary btn--block" data-auth-open="login">${icon('login')}Iniciar sesión</button>
        <button type="button" class="btn btn--ghost btn--block" data-auth-open="register">${icon('userPlus')}Crear cuenta</button>
      </div>
      <ul class="user-menu__list">
        <li><a href="#/settings/help">${icon('help')}Ayuda y soporte</a></li>
      </ul>
      ${demoSwitcher(null)}
      ${resetItem ? `<ul class="user-menu__list user-menu__list--footer">${resetItem}</ul>` : ''}`;
  } else {
    panel.innerHTML = `
      <div class="user-menu__header">
        <div><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)}</small></div>
      </div>
      <ul class="user-menu__list">
        <li><a href="#/profile">${icon('user')}Mi perfil</a></li>
        <li><a href="#/seller/overview">${icon('store')}Panel de vendedor${sellerPending ? `<span class="count-pill">${sellerPending}</span>` : ''}</a></li>
        <li><a href="#/purchases">${icon('bag')}Mis pedidos</a></li>
        <li><a href="#/buyer/messages">${icon('message')}Mensajes${stats.unreadMessages ? `<span class="count-pill">${stats.unreadMessages}</span>` : ''}</a></li>
        <li><a href="#/favorites">${icon('heart')}Favoritos</a></li>
        <li><a href="#/settings/personal">${icon('sliders')}Ajustes</a></li>
        <li><a href="#/settings/help">${icon('help')}Ayuda y soporte</a></li>
      </ul>
      ${demoSwitcher(user)}
      <ul class="user-menu__list user-menu__list--footer">
        ${resetItem}
        <li><button type="button" data-auth-open="login">${icon('login')}Iniciar sesión con otra cuenta</button></li>
        <li><button type="button" data-logout>${icon('logout')}Cerrar sesión</button></li>
      </ul>`;
  }
  panel.hidden = !wasOpen;

  qs('#demo-user-switch', panel)?.addEventListener('change', async (event) => {
    if (!event.target.value) return;
    try {
      await actions.switchDemoUser(event.target.value);
      toast(`Ahora navegas como ${select.currentUser().displayName}`, { tone: 'info' });
      closeUserMenu();
    } catch (error) { handleError(error); }
  });
  qs('#reset-demo', panel)?.addEventListener('click', async () => {
    closeUserMenu();
    const ok = await confirmDialog({ title: '¿Restablecer los datos de prueba?', message: 'Se borrarán los anuncios, pedidos, mensajes, cuentas creadas y cambios guardados en este navegador y se cargarán de nuevo los datos iniciales.', confirmLabel: 'Sí, restablecer', danger: true });
    if (!ok) return;
    try {
      await actions.resetDemoData();
      toast('Datos de prueba restablecidos.');
      navigate('#/home');
    } catch (error) { handleError(error); }
  });
}

/* ==========================================================================
   Acciones globales delegadas (funcionan en cualquier vista)
   ========================================================================== */

function setupGlobalActions() {
  // El enlace «Saltar al contenido» mueve el foco sin pasar por el enrutador.
  document.querySelector('.skip-link')?.addEventListener('click', (event) => {
    event.preventDefault();
    qs('#main').focus();
  });
  // Un enlace a la ruta actual (p. ej. «Publicar anuncio» estando ya en el asistente)
  // no dispara hashchange: lo forzamos para que la vista se reinicie.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#/"]');
    if (link && !event.defaultPrevented && link.getAttribute('href') === location.hash && event.button === 0 && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      navigate(link.getAttribute('href'));
    }
  });
  // Botones «Iniciar sesión» / «Crear cuenta» / «Cerrar sesión» de cualquier parte de la página.
  document.addEventListener('click', async (event) => {
    const authButton = event.target.closest('[data-auth-open]');
    if (authButton) {
      closeMenus();
      openAuthDialog({ mode: authButton.dataset.authOpen });
      return;
    }
    const logoutButton = event.target.closest('[data-logout]');
    if (logoutButton) {
      closeMenus();
      try {
        await logout();
        if (resolveRoute(parseRoute()).auth) navigate('#/home');
      } catch (error) { handleError(error); }
    }
  });
  document.addEventListener('click', async (event) => {
    const favButton = event.target.closest('[data-action="toggle-favorite"]');
    if (favButton) {
      event.preventDefault();
      if (!requireLogin('Inicia sesión o crea una cuenta para guardar favoritos.')) return;
      await withBusy(favButton, async () => {
        try {
          const { favorite } = await actions.toggleFavorite(favButton.dataset.listingId);
          toast(favorite ? 'Guardado en favoritos.' : 'Eliminado de favoritos.', { tone: favorite ? 'success' : 'info', timeout: 2500 });
        } catch (error) { handleError(error); }
      });
    }
  });
}

/* ==========================================================================
   Vista: Inicio
   ========================================================================== */

/** Búsquedas rápidas bajo el buscador («Lo más buscado»). */
const POPULAR_SEARCHES = [
  ['Bicicletas', '#/explore?q=bicicleta'],
  ['Consolas', '#/explore?category=gaming'],
  ['Sofás', '#/explore?q=sof%C3%A1'],
  ['Portátiles', '#/explore?q=port%C3%A1til'],
  ['Motos', '#/explore?category=motorbikes'],
];

/** Categorías del mosaico del inicio (el resto, en «Todas»). */
const HOME_CATEGORIES = ['fashion', 'electronics', 'sports', 'home', 'gaming', 'cars', 'housing'];

/** Sección del inicio: rótulo en versalitas + título + fila de tarjetas. */
function homeSection({ id, eyebrow, title, href = '', listings, emptyText = 'Todavía no hay anuncios', band = false, featured = false }) {
  return `
    <section class="home-section ${band ? 'home-band' : ''}" aria-labelledby="${id}">
      <div class="section-title">
        <div class="section-title__text"><span class="eyebrow">${escapeHtml(eyebrow)}</span><h2 id="${id}">${escapeHtml(title)}</h2></div>
        ${href ? `<a href="${href}" class="link-arrow">Ver todos${icon('chevronRight')}</a>` : ''}
      </div>
      ${listingGrid(listings, { emptyTitle: emptyText, columns: 4, cardOptions: { featured } })}
    </section>`;
}

function renderHome(container) {
  const paint = () => {
    const recent = select.searchListings({ sort: 'recent' }).slice(0, 4);
    const featured = select.publicListings().filter((listing) => listing.featured).slice(0, 4);
    const recommended = select.recommendations(4);
    const userId = select.currentUserId();
    const hasListings = userId ? select.listingsBySeller(userId).length > 0 : false;

    container.innerHTML = `
      <div class="container home">
        <section class="hero" aria-labelledby="home-title">
          <div class="hero__text">
            <span class="eyebrow">Mercado de segunda mano</span>
            <h1 id="home-title" class="hero__title">Cierra buenos tratos, cerca de ti</h1>
            <p class="hero__lead">Encuentra artículos de segunda mano de gente de tu zona o publica lo que ya no usas en unos minutos.</p>
            <form class="hero-search" id="hero-search" role="search" aria-label="Buscar anuncios">
              <div class="hero-search__field">
                ${icon('search')}
                <label for="hero-q" class="visually-hidden">Qué buscas</label>
                <input id="hero-q" name="q" type="search" placeholder="¿Qué buscas hoy?" autocomplete="off" />
              </div>
              <span class="hero-search__divider" aria-hidden="true"></span>
              <div class="hero-search__field hero-search__field--where">
                ${icon('pin')}
                <label for="hero-loc" class="visually-hidden">Dónde</label>
                <input id="hero-loc" name="loc" type="text" placeholder="Ciudad o código postal" />
              </div>
              <button type="submit" class="btn btn--primary hero-search__submit" aria-label="Buscar">${icon('chevronRight')}<span>Buscar</span></button>
            </form>
            <div class="popular">
              <span class="popular__label">Lo más buscado:</span>
              ${POPULAR_SEARCHES.map(([label, href]) => `<a class="chip" href="${href}">${escapeHtml(label)}</a>`).join('')}
            </div>
          </div>
          <aside class="hero__aside" aria-label="Publica en la lonja">
            ${scalesEmblem('hero__emblem')}
            ${ornamentRule()}
            <p class="hero__quote">Antaño, los mercaderes cerraban sus tratos en la lonja. Hoy lo haces desde el móvil.</p>
            <a href="#/sell" class="btn btn--secondary">${hasListings ? 'Publicar otro anuncio' : 'Publicar mi primer anuncio'}</a>
          </aside>
        </section>

        <section aria-labelledby="home-cats">
          <div class="heading-rule"><h2 id="home-cats">Explora por categorías</h2></div>
          <ul class="cat-tiles">
            ${HOME_CATEGORIES.map(getCategory).filter(Boolean).map((category) => `
              <li><a class="cat-tile" href="#/explore?category=${category.id}">${icon(category.icon)}${escapeHtml(category.shortName)}</a></li>`).join('')}
            <li><a class="cat-tile" href="#/categories">${icon('grid')}Todas</a></li>
          </ul>
        </section>

        ${homeSection({ id: 'home-recent', eyebrow: 'Recientes', title: 'Recién llegados a la lonja', href: '#/explore?sort=recent', listings: recent })}
        ${featured.length ? homeSection({ id: 'home-featured', eyebrow: 'Destacados', title: 'Selección de la casa', listings: featured, band: true, featured: true }) : ''}
        ${recommended.length ? homeSection({ id: 'home-reco', eyebrow: 'Recomendados', title: 'Pensados para ti', listings: recommended }) : ''}
      </div>`;

    qs('#hero-search', container).addEventListener('submit', (event) => {
      event.preventDefault();
      const params = new URLSearchParams();
      new FormData(event.target).forEach((value, key) => { if (String(value).trim()) params.set(key, String(value).trim()); });
      navigate(`#/explore${params.toString() ? `?${params}` : ''}`);
    });
  };
  paint();
  // Al cambiar los datos (p. ej. un favorito) se repinta conservando el scroll.
  return { update: paint };
}

/* ==========================================================================
   Vista: Explorar / búsqueda con filtros
   ========================================================================== */

const FILTER_KEYS = ['q', 'category', 'op', 'min', 'max', 'loc', 'cond', 'date', 'sort'];
const DATE_OPTIONS = [['', 'Cualquier fecha'], ['1', 'Últimas 24 horas'], ['7', 'Últimos 7 días'], ['30', 'Últimos 30 días']];

function renderExplore(container, params, preset) {
  const routeBase = preset.vertical ? (preset.vertical === 'vehicles' ? '#/vehicles' : '#/housing') : preset.op ? '#/rentals' : '#/explore';
  const title = preset.vertical ? VERTICALS[preset.vertical].label : preset.op === 'rent' ? 'Alquileres' : 'Explorar anuncios';
  const subtitle = preset.vertical === 'vehicles' ? 'Coches y motos en venta o alquiler.'
    : preset.vertical === 'realestate' ? 'Viviendas en venta y alquiler, y habitaciones.'
      : preset.op === 'rent' ? 'Todo lo que puedes alquilar: vehículos, viviendas, material deportivo, tecnología…'
        : 'Busca entre todos los anuncios publicados.';
  const filters = Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) ?? '']));
  const selectedConditions = filters.cond ? filters.cond.split(',') : [];
  const availableCategories = preset.vertical ? CATEGORIES.filter((category) => VERTICALS[preset.vertical].categories.includes(category.id)) : CATEGORIES;
  const sortOptions = [['recent', 'Más recientes'], ['price_asc', 'Precio: de menor a mayor'], ['price_desc', 'Precio: de mayor a menor']];

  container.innerHTML = `
    <div class="container page">
      <nav class="breadcrumb" aria-label="Ruta de navegación">
        <ol>
          <li><a href="#/home">Inicio</a></li>
          ${routeBase === '#/explore' ? '<li aria-current="page">Explorar</li>' : `<li><a href="#/explore">Explorar</a></li><li aria-current="page">${escapeHtml(title)}</li>`}
        </ol>
      </nav>
      <header class="explore-head">
        <div class="explore-head__title">
          <h1>${escapeHtml(title)}</h1>
          <span class="explore-head__count" id="results-count" aria-live="polite"></span>
        </div>
        <p class="explore-head__subtitle">${escapeHtml(subtitle)}</p>
      </header>
      <div class="explore">
        <aside class="explore__filters card" id="explore-filters" aria-labelledby="filters-title">
          <form id="filters-form" novalidate>
            <div class="explore__filters-head">
              <button type="button" class="icon-btn explore__filters-close" data-close-filters aria-label="Cerrar filtros">${icon('x')}</button>
              <h2 id="filters-title">Filtros</h2>
              <button type="button" class="link-btn" id="clear-filters">Limpiar filtros</button>
            </div>
            <div class="filters-rule" aria-hidden="true"></div>
            ${renderField({ name: 'q', label: 'Palabras clave', type: 'search', value: filters.q, placeholder: 'Ej.: bicicleta' })}
            ${renderField({ name: 'category', label: 'Categoría', type: 'select', value: filters.category, emptyOption: 'Todas las categorías', options: availableCategories.map((category) => [category.id, category.name]) })}
            ${preset.op ? '' : renderField({ name: 'op', label: 'Venta o alquiler', type: 'select', value: filters.op, emptyOption: 'Venta y alquiler', options: [['sale', 'Venta'], ['rent', 'Alquiler']] })}
            <fieldset>
              <legend class="field__label">Precio (€)</legend>
              <div class="explore__price">
                ${renderField({ name: 'min', label: 'Mínimo', type: 'number', value: filters.min, min: 0 })}
                ${renderField({ name: 'max', label: 'Máximo', type: 'number', value: filters.max, min: 0 })}
              </div>
            </fieldset>
            ${renderField({ name: 'loc', label: 'Ubicación', value: filters.loc, placeholder: 'Ciudad o código postal' })}
            <fieldset>
              <legend class="field__label">Estado del artículo</legend>
              <div class="choice-list">
                ${ITEM_CONDITIONS.map(([value, label]) => `<label class="choice"><input type="checkbox" name="cond" value="${value}" ${selectedConditions.includes(value) ? 'checked' : ''} /><span>${escapeHtml(label)}</span></label>`).join('')}
              </div>
            </fieldset>
            <fieldset>
              <legend class="field__label">Fecha de publicación</legend>
              <div class="choice-list">
                ${DATE_OPTIONS.map(([value, label]) => `<label class="choice"><input type="radio" name="date" value="${value}" ${filters.date === value ? 'checked' : ''} /><span>${escapeHtml(label)}</span></label>`).join('')}
              </div>
            </fieldset>
            <div class="explore__filters-foot"><button type="button" class="btn btn--primary" data-close-filters data-apply-label>Ver anuncios</button></div>
          </form>
        </aside>
        <section class="explore__results" aria-label="Resultados">
          <div class="results-bar">
            <button type="button" class="btn btn--ghost explore__filters-toggle" aria-expanded="false" aria-controls="explore-filters">${icon('filter')}Filtros<span class="count-pill" data-filter-count hidden></span></button>
            <ul class="chip-row" id="active-filters" aria-label="Filtros activos"></ul>
            <div class="field field--inline results-bar__sort">
              <label for="sort-select" class="field__label">Ordenar por</label>
              <select id="sort-select" name="sort">
                ${sortOptions.map(([value, label]) => `<option value="${value}" ${(filters.sort || 'recent') === value ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </div>
          </div>
          <div id="results"></div>
        </section>
      </div>
    </div>`;

  const form = qs('#filters-form', container);
  const sortSelect = qs('#sort-select', container);
  const panel = qs('#explore-filters', container);
  const toggle = qs('.explore__filters-toggle', container);

  /** Lee los filtros del formulario (el estado admite varias casillas). */
  const readFilters = () => {
    const data = new FormData(form);
    const values = Object.fromEntries(['q', 'category', 'op', 'min', 'max', 'loc', 'date'].map((key) => [key, String(data.get(key) ?? '').trim()]));
    values.cond = data.getAll('cond').join(',');
    values.sort = sortSelect.value;
    return values;
  };

  /** Filtros activos como píldoras con botón para quitarlos. */
  const activeChips = (values) => {
    const chips = [];
    if (values.q) chips.push(['q', `«${values.q}»`]);
    if (values.category) chips.push(['category', getCategory(values.category)?.name ?? values.category]);
    if (values.op) chips.push(['op', OPERATION_LABELS[values.op] ?? values.op]);
    if (values.min || values.max) chips.push(['price', values.min && values.max ? `Precio: ${values.min}–${values.max} €` : values.min ? `Desde ${values.min} €` : `Hasta ${values.max} €`]);
    if (values.loc) chips.push(['loc', values.loc]);
    if (values.cond) chips.push(['cond', values.cond.split(',').map((value, index) => (index ? conditionLabel(value).toLowerCase() : conditionLabel(value))).join(' o ')]);
    if (values.date) chips.push(['date', DATE_OPTIONS.find(([value]) => value === values.date)?.[1] ?? values.date]);
    return chips;
  };

  const paintResults = () => {
    const values = readFilters();
    const results = select.searchListings({ ...values, ...preset });
    const chips = activeChips(values);
    qs('#results-count', container).textContent = `${results.length} ${results.length === 1 ? 'resultado' : 'resultados'}`;
    qs('#active-filters', container).innerHTML = chips.length
      ? chips.map(([key, label]) => `<li><button type="button" class="chip chip--removable" data-remove-filter="${key}" aria-label="Quitar filtro: ${escapeHtml(label)}">${escapeHtml(label)}${icon('x')}</button></li>`).join('')
      : '<li class="results-bar__none">Sin filtros activos</li>';
    const countPill = qs('[data-filter-count]', container);
    countPill.hidden = !chips.length;
    countPill.textContent = String(chips.length);
    qs('[data-apply-label]', container).textContent = `Ver ${results.length} ${results.length === 1 ? 'anuncio' : 'anuncios'}`;
    qs('#results', container).innerHTML = listingGrid(results, {
      columns: 3,
      emblem: true,
      emptyTitle: 'No hay resultados',
      emptyText: 'Prueba con otras palabras o elimina algunos filtros.',
      emptyAction: chips.length ? '<button type="button" class="btn btn--secondary" data-clear-filters>Limpiar filtros</button>' : '',
    }) + (results.length ? `<div class="results-end"><p>Has visto ${results.length} de ${results.length} ${results.length === 1 ? 'anuncio' : 'anuncios'}</p>${ornamentRule()}</div>` : '');
  };
  const syncUrl = () => {
    const values = readFilters();
    const search = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => { if (value && !(key === 'sort' && value === 'recent')) search.set(key, value); });
    replaceHash(`${routeBase}${search.toString() ? `?${search}` : ''}`);
  };
  const onChange = () => { paintResults(); syncUrl(); };
  const onChangeDebounced = debounce(onChange, 220);
  const clearFilters = () => {
    form.reset();
    qsa('input[type="search"], input[type="text"], input[type="number"], select', form).forEach((element) => { element.value = ''; });
    qsa('input[name="cond"]', form).forEach((element) => { element.checked = false; });
    qs('input[name="date"][value=""]', form).checked = true;
    sortSelect.value = 'recent';
    onChange();
  };
  const removeFilter = (key) => {
    if (key === 'price') { form.elements.min.value = ''; form.elements.max.value = ''; }
    else if (key === 'cond') qsa('input[name="cond"]', form).forEach((element) => { element.checked = false; });
    else if (key === 'date') qs('input[name="date"][value=""]', form).checked = true;
    else if (form.elements[key]) form.elements[key].value = '';
    onChange();
  };

  // Panel de filtros (en móvil se abre como hoja inferior sobre la lista).
  let backdrop = null;
  const onKeydown = (event) => { if (event.key === 'Escape') setPanel(false); };
  const setPanel = (open) => {
    if (open === panel.classList.contains('is-open')) return;
    toggle.setAttribute('aria-expanded', String(open));
    panel.classList.toggle('is-open', open);
    document.body.classList.toggle('has-modal', open);
    if (open) {
      backdrop = document.createElement('div');
      backdrop.className = 'sheet-backdrop';
      backdrop.addEventListener('click', () => setPanel(false));
      document.body.append(backdrop);
      document.addEventListener('keydown', onKeydown);
      qs('.explore__filters-close', panel)?.focus();
    } else {
      backdrop?.remove();
      backdrop = null;
      document.removeEventListener('keydown', onKeydown);
      toggle.focus({ preventScroll: true });
    }
  };
  // Si la ventana pasa a tamaño de escritorio con la hoja abierta, se cierra.
  const desktopQuery = window.matchMedia('(min-width: 901px)');
  const onViewportChange = (event) => { if (event.matches) setPanel(false); };
  desktopQuery.addEventListener('change', onViewportChange);

  form.addEventListener('input', onChangeDebounced);
  form.addEventListener('change', onChange);
  form.addEventListener('submit', (event) => event.preventDefault());
  sortSelect.addEventListener('change', onChange);
  qs('#clear-filters', container).addEventListener('click', clearFilters);
  toggle.addEventListener('click', () => setPanel(!panel.classList.contains('is-open')));
  qsa('[data-close-filters]', panel).forEach((button) => button.addEventListener('click', () => setPanel(false)));
  container.addEventListener('click', (event) => {
    if (event.target.closest('[data-clear-filters]')) clearFilters();
    const removeButton = event.target.closest('[data-remove-filter]');
    if (removeButton) removeFilter(removeButton.dataset.removeFilter);
  });

  // Sincroniza el buscador de la cabecera con los filtros actuales.
  qs('#header-search-input').value = filters.q;

  paintResults();
  return {
    update: paintResults,
    destroy: () => {
      setPanel(false);
      desktopQuery.removeEventListener('change', onViewportChange);
    },
  };
}

/* ==========================================================================
   Vista: Categorías
   ========================================================================== */

function renderCategories(container) {
  container.innerHTML = `
    <div class="container page">
      <nav class="breadcrumb" aria-label="Ruta de navegación"><ol><li><a href="#/home">Inicio</a></li><li aria-current="page">Categorías</li></ol></nav>
      <header class="page-header"><div><h1>Categorías</h1><p class="muted">Elige una categoría para ver sus anuncios activos.</p></div></header>
      <ul class="category-grid">
        ${CATEGORIES.map((category) => {
          const sale = select.searchListings({ category: category.id, op: 'sale' }).length;
          const rent = select.searchListings({ category: category.id, op: 'rent' }).length;
          return `
            <li>
              <a class="category-card card" href="#/explore?category=${category.id}">
                <span class="category-card__icon">${icon(category.icon)}</span>
                <span class="category-card__body">
                  <strong>${escapeHtml(category.name)}</strong>
                  <small>${category.operations.includes('sale') ? `${sale} en venta` : ''}${category.operations.length > 1 ? ' · ' : ''}${category.operations.includes('rent') ? `${rent} en alquiler` : ''}</small>
                </span>
                ${icon('chevronRight')}
              </a>
            </li>`;
        }).join('')}
      </ul>
    </div>`;
}

/* ==========================================================================
   Vista: Detalle de anuncio
   ========================================================================== */

/** Cuenta una visita por anuncio y sesión del navegador (evita inflar el contador al recargar). */
function registerViewOnce(listing) {
  if (listing.sellerId === select.currentUserId() || listing.status !== 'active') return;
  let viewed = [];
  try { viewed = JSON.parse(safeStorage.get('sessionStorage', 'lonja.viewed') ?? '[]'); } catch { viewed = []; }
  const key = `${select.currentUserId()}:${listing.id}`;
  if (viewed.includes(key)) return;
  safeStorage.set('sessionStorage', 'lonja.viewed', JSON.stringify([...viewed, key]));
  actions.registerView(listing.id).catch(() => {});
}

/** Frase de entrega a partir de las modalidades marcadas («Entrega en mano o envío.»). */
function deliverySentence(methods) {
  const labels = methods.map(([, method], index) => (index ? method.label.toLowerCase() : method.label));
  if (!labels.length) return '';
  return `${labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} o ${labels.at(-1)}`}.`;
}

function renderListingDetail(container, listingId) {
  let activeImage = 0;
  const paint = () => {
    const listing = select.listing(listingId);
    // Los borradores y los anuncios en revisión solo los ve su propietario.
    const hiddenForOthers = ['draft', 'pending_review'].includes(listing?.status) && listing.sellerId !== select.currentUserId();
    if (!listing || listing.deletedAt || hiddenForOthers) {
      document.body.classList.remove('has-action-bar');
      container.innerHTML = `<div class="container page">${emptyState({ emblem: true, title: 'Anuncio no disponible', text: 'Puede que se haya eliminado o que el enlace no sea correcto.', action: '<a class="btn btn--secondary" href="#/explore">Explorar anuncios</a>' })}</div>`;
      return;
    }
    const category = getCategory(listing.category);
    const seller = select.user(listing.sellerId);
    const privacy = seller.preferences?.privacy ?? {};
    const rating = select.ratingSummary(seller.id);
    const operations = select.sellerStats(seller.id).completedSales;
    const isOwn = listing.sellerId === select.currentUserId();
    const isFav = select.isFavorite(listing.id);
    const availability = select.availability(listing);
    const images = listing.images ?? [];
    activeImage = Math.min(activeImage, Math.max(images.length - 1, 0));
    const isRent = listing.operationType === 'rent';
    const period = RENTAL_PERIODS[listing.rental?.period];
    const bookings = isRent ? select.confirmedBookings(listing.id) : [];
    const attributes = category.fields
      .filter((field) => isFieldVisible(field, listing))
      .map((field) => [field.label, formatAttribute(field, listing.attributes?.[field.key])])
      .filter(([, value]) => value !== null);
    const generalRows = [
      listing.condition ? ['Estado', conditionLabel(listing.condition)] : null,
      listing.brand ? ['Marca', listing.brand] : null,
      listing.model ? ['Modelo', listing.model] : null,
      listing.availability ? ['Disponibilidad', listing.availability] : null,
    ].filter(Boolean);
    const allRows = [...generalRows, ...attributes, ...(listing.customAttributes ?? []).map((item) => [item.label, item.value]), ['Categoría', category.name]];
    const deliveryList = Object.entries(DELIVERY_METHODS).filter(([key]) => listing.delivery?.[key]);
    const actionLabel = isRent ? 'Solicitar alquiler' : ['vehicles', 'realestate'].includes(category.vertical) ? 'Solicitar compra' : 'Comprar';
    const messageHref = `#/buyer/messages?listing=${listing.id}&with=${seller.id}`;
    const related = select.searchListings({ category: listing.category }).filter((item) => item.id !== listing.id).slice(0, 4);
    const isReserved = listing.status === 'active' && listing.operationType === 'sale' && select.openSaleOrder(listing.id);

    let actionHtml;
    let mobileBar = '';
    if (isOwn) {
      actionHtml = `
        ${notice(`Es tu anuncio (estado: <strong>${escapeHtml(LISTING_STATUS[listing.status]?.label ?? listing.status)}</strong>). Así lo ven los compradores.`)}
        <a href="#/seller/edit/${listing.id}" class="btn btn--primary btn--block">${icon('edit')}Editar anuncio</a>
        <a href="#/seller/listings" class="btn btn--ghost btn--block">Ir a Mis anuncios</a>`;
    } else if (availability.available) {
      actionHtml = `
        <button type="button" class="btn btn--primary btn--block btn--lg" data-buy>${actionLabel}</button>
        <a href="${messageHref}" class="btn btn--ghost btn--block btn--lg">${icon('message')}Enviar mensaje</a>
        ${select.isGuest() ? `<p class="muted small detail__guest-hint">${icon('lock', 'icon--xs')}Necesitas una cuenta para ${isRent ? 'alquilar' : 'comprar'}, escribir al vendedor o guardar favoritos. <button type="button" class="link-btn" data-auth-open="login">Inicia sesión</button></p>` : ''}`;
      // En el móvil, «Mensaje» y la acción principal quedan fijos abajo.
      mobileBar = `
        <div class="detail__mobilebar">
          <a href="${messageHref}" class="btn btn--ghost">${icon('message')}Mensaje</a>
          <button type="button" class="btn btn--primary" data-buy>${actionLabel}</button>
        </div>`;
    } else {
      actionHtml = `
        ${notice(escapeHtml(availability.reason), 'warning')}
        ${availability.ownOrder ? '<a href="#/buyer/orders" class="btn btn--ghost btn--block">Ver mi pedido</a>' : ''}
        <a href="${messageHref}" class="btn btn--ghost btn--block">${icon('message')}Enviar mensaje</a>`;
    }
    document.body.classList.toggle('has-action-bar', Boolean(mobileBar));

    const statusTags = [
      listing.status !== 'active' ? `<span class="tag tag--ink">${escapeHtml(LISTING_STATUS[listing.status]?.label ?? listing.status)}</span>` : '',
      isReserved ? '<span class="tag tag--gold">Reservado</span>' : '',
      isRent ? `<span class="tag">${OPERATION_LABELS.rent}</span>` : '',
    ].join('');
    const favButton = (className) => (isOwn ? '' : `<button type="button" class="${className} ${isFav ? 'is-active' : ''}" data-action="toggle-favorite" data-listing-id="${listing.id}" aria-pressed="${isFav}" aria-label="${isFav ? 'Quitar de favoritos' : 'Guardar en favoritos'}">${icon('heart')}</button>`);
    const sectionRows = (rows) => `<dl class="spec-list">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;

    container.innerHTML = `
      <div class="container page">
        <nav class="breadcrumb" aria-label="Ruta de navegación">
          <ol>
            <li><a href="#/home">Inicio</a></li>
            <li><a href="#/explore?category=${category.id}">${escapeHtml(category.name)}</a></li>
            <li aria-current="page">${escapeHtml(listing.title)}</li>
          </ol>
        </nav>

        <div class="detail">
          <section class="detail__gallery" aria-label="Fotografías">
            <div class="gallery__main">
              ${images.length
                ? `<img src="${escapeHtml(images[activeImage].src)}" alt="${escapeHtml(images[activeImage].alt || listing.title)}" />`
                : `<div class="listing-card__noimg">${icon(category.icon)}<span>Sin fotografías</span></div>`}
              ${statusTags ? `<div class="gallery__tags">${statusTags}</div>` : ''}
              ${favButton('fav-btn detail__gallery-fav')}
              ${images.length > 1 ? `
                <button type="button" class="gallery__nav gallery__nav--prev" data-image-step="-1" aria-label="Foto anterior">${icon('chevronLeft')}</button>
                <button type="button" class="gallery__nav gallery__nav--next" data-image-step="1" aria-label="Foto siguiente">${icon('chevronRight')}</button>
                <span class="gallery__counter" aria-live="polite">${activeImage + 1} / ${images.length}</span>` : ''}
            </div>
            ${images.length > 1 ? `
              <ul class="gallery__thumbs">
                ${images.map((image, index) => `
                  <li><button type="button" class="gallery__thumb ${index === activeImage ? 'is-active' : ''}" data-image-index="${index}" aria-label="Ver foto ${index + 1} de ${images.length}" aria-pressed="${index === activeImage}">
                    <img src="${escapeHtml(image.src)}" alt="" />
                  </button></li>`).join('')}
              </ul>` : ''}
          </section>

          <div class="detail__aside">
            <section class="detail__summary card" aria-labelledby="listing-title">
              <div class="detail__head">
                <h1 id="listing-title" class="detail__title">${escapeHtml(listing.title)}</h1>
                ${favButton('icon-btn icon-btn--round')}
              </div>
              <p class="detail__price">${priceLabel(listing)}</p>
              ${isRent && listing.attributes?.deposit ? `<p class="muted">Fianza: ${formatMoney(listing.attributes.deposit)}</p>` : ''}
              <p class="detail__meta">
                <span>${icon('pin', 'icon--xs')}${escapeHtml([listing.location.zone, listing.location.city].filter(Boolean).join(', '))}</span>
                <span>Publicado ${timeAgo(listing.createdAt)}</span>
                ${listing.condition ? badge(conditionLabel(listing.condition), 'success', 'badge--plain') : ''}
                ${listing.status !== 'active' ? listingStatusBadge(listing.status) : ''}
              </p>
              <p class="detail__stats"><span>${icon('eye', 'icon--xs')}${listing.views ?? 0} visitas</span><span>${icon('heart', 'icon--xs')}${select.favoriteCountFor(listing.id)} en favoritos</span></p>
              <div class="detail__actions">${actionHtml}</div>
              ${deliveryList.length ? `<p class="detail__delivery">${icon('truck')}${escapeHtml(deliverySentence(deliveryList))}</p>` : ''}
            </section>

            <section class="seller-box card" aria-labelledby="seller-title">
              <h2 id="seller-title" class="eyebrow">El vendedor</h2>
              <div class="seller-box__who">
                ${avatar(seller, 'lg')}
                <div>
                  <span class="seller-box__name">${escapeHtml(seller.displayName)}</span>
                  ${privacy.showRating !== false ? `<span class="seller-box__rating">${rating.average !== null ? `${stars(rating.average, { showValue: false })}${formatRating(rating.average)} de 5 · ${rating.count} ${rating.count === 1 ? 'valoración' : 'valoraciones'}` : 'Sin valoraciones todavía'}</span>` : ''}
                </div>
              </div>
              <p class="seller-box__facts">
                ${operations} ${operations === 1 ? 'operación cerrada' : 'operaciones cerradas'}${privacy.showJoinDate !== false ? ` · en ${escapeHtml(APP_CONFIG.brandName.toUpperCase())} desde ${new Date(seller.createdAt).getFullYear()}` : ''}
                ${privacy.showCity !== false && seller.publicLocation ? `<br />${escapeHtml(seller.publicLocation)}` : ''}
              </p>
              <a class="seller-box__link" href="#/user/${seller.id}">Ver perfil y otros anuncios</a>
            </section>
            ${isOwn ? '' : `<button type="button" class="link-btn detail__report" data-report>${icon('flag')}Denunciar este anuncio</button>`}
          </div>

          <div class="detail__content">
            <section class="detail__section" aria-labelledby="desc-title">
              <h2 id="desc-title">Descripción</h2>
              <p class="prewrap">${escapeHtml(listing.description)}</p>
            </section>
            <section class="detail__section" aria-labelledby="specs-title">
              <h2 id="specs-title">Características</h2>
              <hr class="double-rule" />
              ${sectionRows(allRows)}
            </section>
            ${isRent ? `
              <section class="detail__section" aria-labelledby="rent-title">
                <h2 id="rent-title">Condiciones del alquiler</h2>
                <hr class="double-rule" />
                ${sectionRows([
                  ['Periodicidad', period?.label ?? '—'],
                  ['Duración mínima', `${listing.rental.minDuration} ${listing.rental.minDuration === 1 ? period?.unit : period?.unitPlural}`],
                  ['Duración máxima', listing.rental.maxDuration ? `${listing.rental.maxDuration} ${period?.unitPlural}` : 'Sin límite'],
                ])}
                ${listing.rental.requirements ? `<h3>Requisitos del arrendatario</h3><p class="prewrap">${escapeHtml(listing.rental.requirements)}</p>` : ''}
                ${category.rentNote ? notice(escapeHtml(category.rentNote)) : ''}
                <h3>Fechas ya reservadas</h3>
                ${bookings.length ? `<ul class="booking-list">${bookings.map((booking) => `<li>${icon('calendar', 'icon--xs')}${formatDate(booking.startDate)} → ${formatDate(booking.endDate)}</li>`).join('')}</ul>` : '<p class="muted">No hay reservas confirmadas. Todas las fechas están libres.</p>'}
              </section>` : ''}
            <section class="detail__section" aria-labelledby="delivery-title">
              <h2 id="delivery-title">Entrega y recogida</h2>
              <hr class="double-rule" />
              <ul class="delivery-list">${deliveryList.map(([, method]) => `<li>${icon(method.icon)}${escapeHtml(method.label)}</li>`).join('')}</ul>
              ${listing.deliveryNotes ? `<p class="prewrap">${escapeHtml(listing.deliveryNotes)}</p>` : ''}
              <p class="muted small">La dirección exacta nunca se publica: se acuerda por mensaje entre las partes.</p>
            </section>
          </div>
        </div>

        ${related.length ? `
          <section class="related" aria-labelledby="related-title">
            <div class="heading-rule heading-rule--plain"><h2 id="related-title">También te puede interesar</h2></div>
            ${listingGrid(related, { columns: 4 })}
          </section>` : ''}
        ${mobileBar}
      </div>`;

    const showImage = (index) => {
      activeImage = (index + images.length) % images.length;
      paint();
    };
    qsa('[data-image-index]', container).forEach((button) => button.addEventListener('click', () => {
      showImage(Number(button.dataset.imageIndex));
      qs(`[data-image-index="${activeImage}"]`, container)?.focus();
    }));
    qsa('[data-image-step]', container).forEach((button) => button.addEventListener('click', () => {
      const step = Number(button.dataset.imageStep);
      showImage(activeImage + step);
      qs(`[data-image-step="${step}"]`, container)?.focus();
    }));
    qsa('[data-buy]', container).forEach((button) => button.addEventListener('click', () => {
      if (requireLogin(`Inicia sesión o crea una cuenta para ${isRent ? 'solicitar el alquiler' : 'comprar este artículo'}.`)) openPurchaseDialog(listing);
    }));
    qs('[data-report]', container)?.addEventListener('click', () => {
      if (requireLogin('Inicia sesión para denunciar un anuncio.')) openReportDialog(listing);
    });
  };

  paint();
  const listing = select.listing(listingId);
  if (listing) registerViewOnce(listing);
  return { update: paint, destroy: () => document.body.classList.remove('has-action-bar') };
}

/* ==========================================================================
   Vista: Perfil público
   ========================================================================== */

function renderPublicProfile(container, userId) {
  const paint = () => {
    const user = select.user(userId);
    if (!user) {
      container.innerHTML = `<div class="container page">${emptyState({ iconName: 'user', title: 'Usuario no encontrado' })}</div>`;
      return;
    }
    const isOwn = user.id === select.currentUserId();
    const privacy = user.preferences?.privacy ?? {};
    if (privacy.profileVisibility === 'private' && !isOwn) {
      container.innerHTML = `<div class="container page">${emptyState({ iconName: 'lock', title: 'Perfil privado', text: 'Este usuario ha decidido no mostrar su perfil públicamente.' })}</div>`;
      return;
    }
    if (privacy.profileVisibility === 'registered' && select.isGuest()) {
      container.innerHTML = `<div class="container page">${emptyState({ iconName: 'lock', title: 'Perfil solo para usuarios registrados', text: 'Este usuario solo muestra su perfil a quien ha iniciado sesión.', action: `<button type="button" class="btn btn--primary" data-auth-open="login">${icon('login')}Iniciar sesión</button>` })}</div>`;
      return;
    }
    const rating = select.ratingSummary(user.id);
    const listings = select.listingsBySeller(user.id).filter((listing) => listing.status === 'active');
    const reviews = select.reviewsFor(user.id);

    container.innerHTML = `
      <div class="container page">
        ${isOwn ? notice(`Así ven tu perfil otros usuarios. Visibilidad actual: <strong>${{ public: 'pública', registered: 'solo usuarios registrados', private: 'privada' }[privacy.profileVisibility] ?? 'pública'}</strong>. <a href="#/settings/public">Editar perfil público</a>`) : ''}
        <section class="profile-hero card">
          ${avatar(user, 'xl')}
          <div class="profile-hero__body">
            <h1>${escapeHtml(user.displayName)}</h1>
            <p class="muted">@${escapeHtml(user.username)}</p>
            ${user.bio ? `<p>${escapeHtml(user.bio)}</p>` : ''}
            <ul class="profile-hero__facts">
              ${privacy.showCity !== false && user.publicLocation ? `<li>${icon('pin', 'icon--xs')}${escapeHtml(user.publicLocation)}</li>` : ''}
              ${privacy.showJoinDate !== false ? `<li>${icon('calendar', 'icon--xs')}En ${escapeHtml(APP_CONFIG.brandName.toUpperCase())} desde ${formatDate(user.createdAt, { day: undefined })}</li>` : ''}
              <li>${icon('tag', 'icon--xs')}${listings.length} ${listings.length === 1 ? 'anuncio activo' : 'anuncios activos'}</li>
              ${privacy.showRating !== false ? `<li>${stars(rating.average)} <span class="muted">(${rating.count} ${rating.count === 1 ? 'valoración' : 'valoraciones'})</span></li>` : ''}
            </ul>
          </div>
        </section>

        <section class="home-section related" aria-labelledby="profile-listings">
          <div class="section-title"><div class="section-title__text"><span class="eyebrow">En la lonja</span><h2 id="profile-listings">Anuncios activos</h2></div></div>
          ${listingGrid(listings, { emptyTitle: 'No tiene anuncios activos', columns: 3 })}
        </section>

        ${privacy.showRating !== false ? `
          <section class="home-section related" aria-labelledby="profile-reviews">
            <div class="section-title"><div class="section-title__text"><span class="eyebrow">Opiniones</span><h2 id="profile-reviews">Valoraciones</h2></div></div>
            ${reviews.length ? `<ul class="review-list">${reviews.map((review) => {
              const reviewer = select.user(review.reviewerId);
              const reviewed = select.listing(review.listingId);
              return `<li class="review card">${avatar(reviewer, 'sm')}<div><p><strong>${escapeHtml(reviewer?.displayName ?? 'Usuario')}</strong> ${stars(review.rating, { showValue: false })}</p><p>${escapeHtml(review.comment)}</p><small class="muted">${escapeHtml(reviewed?.title ?? '')} · ${timeAgo(review.createdAt)}</small></div></li>`;
            }).join('')}</ul>` : emptyState({ iconName: 'star', title: 'Todavía no hay valoraciones' })}
          </section>` : ''}
      </div>`;
  };
  paint();
  return { update: paint };
}

function renderNotFound(container) {
  container.innerHTML = `<div class="container page">${emptyState({ emblem: true, title: 'Página no encontrada', text: 'La sección que buscas no existe.', action: '<a class="btn btn--secondary" href="#/home">Volver al inicio</a>' })}</div>`;
}

/* ==========================================================================
   Arranque
   ========================================================================== */

/** Aviso superior: dónde se guardan los datos en esta versión. */
function updateDemoBanner() {
  const banner = qs('.demo-banner');
  if (!banner) return;
  banner.innerHTML = select.dataSource() === 'neon'
    ? '<strong>Versión de prueba.</strong> Los datos se guardan en una base de datos compartida: lo que publiques lo verá cualquiera. No hay pagos reales.'
    : '<strong>Modo local.</strong> Los anuncios, pedidos y mensajes se guardan solo en este navegador. No hay pagos reales.';
}

async function bootstrap() {
  injectIconSprite();
  setupHeader();
  setupGlobalActions();
  updateDemoBanner();
  try {
    await initStore();
  } catch (error) {
    console.error(error);
    viewContainer().innerHTML = `<div class="container page">${emptyState({ iconName: 'alert', title: 'No se pudieron cargar los datos', text: select.dataSource() === 'neon' ? 'No se pudo conectar con la base de datos. Comprueba tu conexión y recarga la página.' : 'Comprueba que el navegador permite LocalStorage e inténtalo de nuevo.' })}</div>`;
    return;
  }
  let lastUserId = select.currentUserId();
  subscribe(() => {
    updateHeader();
    // Al entrar, salir o cambiar de cuenta se vuelve a dibujar la vista completa
    // (cambian permisos, «Tu anuncio», paneles privados…).
    if (select.currentUserId() !== lastUserId) {
      lastUserId = select.currentUserId();
      route({ authChange: true });
    } else {
      currentView?.update?.();
    }
  });
  updateHeader();
  window.addEventListener('hashchange', () => route());
  if (!location.hash) replaceHash('#/home');
  route();
  promptLoginOnFirstVisit();
  if (!select.isPersistent()) {
    toast('Este navegador no permite guardar datos: los cambios se perderán al recargar la página.', { tone: 'warning', timeout: 9000 });
  }
}

if (location.protocol !== 'file:') bootstrap();
