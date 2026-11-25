/**
 * auth.js
 * ---------------------------------------------------------------------------
 * ACCESO A LA CUENTA: cuadro de inicio de sesión / registro y modo invitado.
 *
 *  - Al abrir la página sin sesión aparece un cuadro (no ocupa toda la
 *    pantalla) con tres opciones: entrar con una cuenta, crear una cuenta o
 *    cerrarlo y seguir como invitado.
 *  - Un invitado puede ver anuncios, categorías y perfiles públicos. Para
 *    comprar, alquilar, guardar favoritos, enviar mensajes, denunciar o
 *    publicar se le vuelve a pedir que inicie sesión (requireLogin).
 *
 * Las cuentas se crean en Neon Auth (ver neon-auth.js y api.js). Si se cambia el proveedor,
 * solo cambian las llamadas de store.js/api.js: este cuadro sigue igual.
 */

import { APP_CONFIG } from './data.js';
import { icon } from './icons.js';
import { actions, select } from './store.js';
import { ApiError } from './api.js';
import { handleError, notice, openModal, qs, qsa, renderField, setAuthRequiredHandler, showFormErrors, toast, withBusy } from './ui.js';
import { escapeHtml, safeStorage } from './utils.js';

/** Cuadro abierto en este momento (solo puede haber uno). */
let activeDialog = null;

/** Prefijos de los campos para que sus ids no choquen con los formularios de la página. */
const LOGIN_FIELDS = { identifier: 'loginIdentifier', password: 'loginPassword' };
const REGISTER_FIELDS = {
  firstName: 'regFirstName', lastName: 'regLastName', username: 'regUsername', email: 'regEmail',
  password: 'regPassword', passwordConfirm: 'regPasswordConfirm', acceptTerms: 'regAcceptTerms',
};

/** Convierte los errores de la API (por campo) a los nombres de los campos del formulario. */
const mapErrors = (details, names) => Object.fromEntries(Object.entries(details ?? {}).map(([key, message]) => [names[key] ?? key, message]));

function loginForm() {
  return `
    <form id="auth-login" class="auth__panel" role="tabpanel" aria-labelledby="auth-tab-login" novalidate>
      ${renderField({ name: LOGIN_FIELDS.identifier, label: 'Correo o nombre de usuario', autocomplete: 'username', required: true, maxLength: 120 })}
      ${renderField({ name: LOGIN_FIELDS.password, label: 'Contraseña', type: 'password', autocomplete: 'current-password', required: true, maxLength: 128 })}
      <p class="auth__error" data-auth-error role="alert" hidden></p>
      <button type="submit" class="btn btn--primary btn--block btn--lg">${icon('login')}Entrar</button>
      <p class="auth__switch">¿No tienes cuenta? <button type="button" class="link-btn" data-auth-tab="register">Crea una gratis</button></p>
    </form>`;
}

function registerForm() {
  return `
    <form id="auth-register" class="auth__panel" role="tabpanel" aria-labelledby="auth-tab-register" novalidate hidden>
      <div class="auth__grid">
        ${renderField({ name: REGISTER_FIELDS.firstName, label: 'Nombre', autocomplete: 'given-name', required: true, maxLength: 50 })}
        ${renderField({ name: REGISTER_FIELDS.lastName, label: 'Apellidos', autocomplete: 'family-name', required: true, maxLength: 80 })}
      </div>
      ${renderField({ name: REGISTER_FIELDS.username, label: 'Nombre de usuario', autocomplete: 'username', required: true, maxLength: 20, help: 'Se muestra en tus anuncios. 3–20 caracteres: minúsculas, números, «_» o «.».' })}
      ${renderField({ name: REGISTER_FIELDS.email, label: 'Correo electrónico', type: 'email', autocomplete: 'email', required: true, maxLength: 120 })}
      <div class="auth__grid">
        ${renderField({ name: REGISTER_FIELDS.password, label: 'Contraseña', type: 'password', autocomplete: 'new-password', required: true, maxLength: 128 })}
        ${renderField({ name: REGISTER_FIELDS.passwordConfirm, label: 'Repite la contraseña', type: 'password', autocomplete: 'new-password', required: true, maxLength: 128 })}
      </div>
      <p class="field__help auth__hint">Mínimo ${APP_CONFIG.passwordMinLength} caracteres, con letras y números.</p>
      ${renderField({ name: REGISTER_FIELDS.acceptTerms, label: 'Acepto las condiciones de uso y la política de privacidad', type: 'checkbox', required: true })}
      <p class="auth__error" data-auth-error role="alert" hidden></p>
      <button type="submit" class="btn btn--primary btn--block btn--lg">${icon('userPlus')}Crear cuenta</button>
      <p class="auth__switch">¿Ya tienes cuenta? <button type="button" class="link-btn" data-auth-tab="login">Inicia sesión</button></p>
    </form>`;
}

function demoAccounts() {
  const demoUsers = select.demoUsers();
  if (!demoUsers.length) return '';
  return `
    <details class="auth__demo">
      <summary>Probar con una cuenta de demostración</summary>
      <div class="auth__demo-body">
        <label class="field__label" for="auth-demo-user">Cuenta de prueba</label>
        <div class="auth__demo-row">
          <select id="auth-demo-user">
            ${demoUsers.map((user) => `<option value="${user.id}">${escapeHtml(user.displayName)} (@${escapeHtml(user.username)})</option>`).join('')}
          </select>
          <button type="button" class="btn btn--ghost" data-demo-login>Entrar</button>
        </div>
        <p class="field__help">También puedes entrar con su correo y la contraseña <code>${escapeHtml(APP_CONFIG.demoPassword)}</code>.</p>
      </div>
    </details>`;
}

/**
 * Abre el cuadro de acceso.
 * @param {object} options
 * @param {'login'|'register'} options.mode  pestaña inicial
 * @param {string} options.reason  por qué se pide (p. ej. «Inicia sesión para guardar favoritos»)
 * @param {boolean} options.welcome  cuadro de bienvenida al abrir la página
 */
export function openAuthDialog({ mode = 'login', reason = '', welcome = false } = {}) {
  if (activeDialog) {
    activeDialog.switchTo(mode);
    if (reason) activeDialog.setReason(reason);
    return;
  }
  let signedIn = false;
  const current = select.currentUser();
  const { element, close } = openModal({
    title: welcome ? `Te damos la bienvenida a ${APP_CONFIG.brandName}` : 'Accede a tu cuenta',
    size: 'auth',
    body: `
      <div class="auth">
        <p class="auth__intro">${current
          ? `Has iniciado sesión como <strong>${escapeHtml(current.displayName)}</strong>. Puedes entrar con otra cuenta o crear una nueva.`
          : 'Entra para comprar, alquilar, vender y guardar tus favoritos.'}</p>
        <div data-auth-reason></div>
        <div class="auth__tabs" role="tablist" aria-label="Tipo de acceso">
          <button type="button" class="auth__tab" role="tab" id="auth-tab-login" aria-controls="auth-login" data-auth-tab="login">Iniciar sesión</button>
          <button type="button" class="auth__tab" role="tab" id="auth-tab-register" aria-controls="auth-register" data-auth-tab="register">Crear cuenta</button>
        </div>
        ${loginForm()}
        ${registerForm()}
        ${demoAccounts()}
        <p class="auth__local muted small">${icon('info', 'icon--xs')}${select.usesRemoteAccounts()
          ? 'Tu cuenta se guarda de forma segura en el servidor: podrás entrar desde cualquier navegador.'
          : 'Demostración: las cuentas se guardan solo en este navegador.'}</p>
      </div>`,
    footer: current
      ? '<button type="button" class="btn btn--ghost" data-modal-close>Cancelar</button>'
      : `<p class="auth__guest-note">Sin cuenta puedes ver anuncios y perfiles.</p>
         <button type="button" class="btn btn--ghost" data-modal-close data-guest>Seguir como invitado</button>`,
    onClose: () => {
      activeDialog = null;
      if (!signedIn && welcome && select.isGuest()) toast('Navegas como invitado. Puedes iniciar sesión cuando quieras desde el menú de usuario.', { tone: 'info' });
    },
  });
  element.querySelector('.modal').classList.add('auth-dialog');

  const loginFormElement = qs('#auth-login', element);
  const registerFormElement = qs('#auth-register', element);

  const switchTo = (target) => {
    const showRegister = target === 'register';
    loginFormElement.hidden = showRegister;
    registerFormElement.hidden = !showRegister;
    qsa('.auth__tab', element).forEach((tab) => {
      const selected = tab.dataset.authTab === target;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    qs('input', showRegister ? registerFormElement : loginFormElement)?.focus();
  };
  const setReason = (text) => {
    qs('[data-auth-reason]', element).innerHTML = text ? notice(escapeHtml(text)) : '';
  };
  const showFormError = (form, message) => {
    const box = qs('[data-auth-error]', form);
    box.textContent = message;
    box.hidden = !message;
  };
  const finish = (message) => {
    signedIn = true;
    close();
    toast(message);
  };

  qsa('[data-auth-tab]', element).forEach((button) => button.addEventListener('click', () => switchTo(button.dataset.authTab)));
  // Flechas izquierda/derecha entre pestañas (patrón de pestañas accesible).
  qs('.auth__tabs', element).addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const next = qs('.auth__tab.is-active', element).dataset.authTab === 'login' ? 'register' : 'login';
    switchTo(next);
    qs(`#auth-tab-${next}`, element).focus();
  });

  loginFormElement.addEventListener('submit', async (event) => {
    event.preventDefault();
    showFormError(loginFormElement, '');
    showFormErrors(loginFormElement, {});
    const form = loginFormElement.elements;
    await withBusy(qs('button[type="submit"]', loginFormElement), async () => {
      try {
        await actions.login({ identifier: form[LOGIN_FIELDS.identifier].value, password: form[LOGIN_FIELDS.password].value });
        finish(`Hola, ${select.currentUser().firstName}. Has iniciado sesión.`);
      } catch (error) {
        if (error instanceof ApiError && error.details) showFormErrors(loginFormElement, mapErrors(error.details, LOGIN_FIELDS));
        else if (error instanceof ApiError) {
          showFormError(loginFormElement, error.message);
          form[LOGIN_FIELDS.password].value = '';
          form[LOGIN_FIELDS.password].focus();
        } else handleError(error);
      }
    });
  });

  registerFormElement.addEventListener('submit', async (event) => {
    event.preventDefault();
    showFormError(registerFormElement, '');
    showFormErrors(registerFormElement, {});
    const form = registerFormElement.elements;
    const payload = Object.fromEntries(Object.entries(REGISTER_FIELDS).map(([key, name]) => [key, form[name].type === 'checkbox' ? form[name].checked : form[name].value]));
    await withBusy(qs('button[type="submit"]', registerFormElement), async () => {
      try {
        await actions.register(payload);
        finish(`Cuenta creada. Ya puedes comprar, vender y alquilar, ${select.currentUser().firstName}.`);
      } catch (error) {
        if (error instanceof ApiError && error.details) showFormErrors(registerFormElement, mapErrors(error.details, REGISTER_FIELDS));
        else if (error instanceof ApiError) showFormError(registerFormElement, error.message);
        else handleError(error);
      }
    });
  });

  qs('[data-demo-login]', element)?.addEventListener('click', async (event) => {
    await withBusy(event.currentTarget, async () => {
      try {
        await actions.switchDemoUser(qs('#auth-demo-user', element).value);
        finish(`Cuenta de prueba activa: ${select.currentUser().displayName}`);
      } catch (error) { handleError(error); }
    });
  });

  setReason(reason);
  switchTo(mode);
  activeDialog = { switchTo, setReason, close };
}

/**
 * Devuelve true si hay sesión. Si el visitante es un invitado, abre el cuadro
 * de acceso explicando por qué y devuelve false.
 */
export function requireLogin(reason = 'Inicia sesión o crea una cuenta para continuar.') {
  if (!select.isGuest()) return true;
  openAuthDialog({ reason });
  return false;
}

/** Muestra el cuadro de bienvenida una vez por pestaña a quien llega sin sesión. */
export function promptLoginOnFirstVisit() {
  if (!select.isGuest() || safeStorage.get('sessionStorage', APP_CONFIG.authPromptKey)) return;
  safeStorage.set('sessionStorage', APP_CONFIG.authPromptKey, '1');
  openAuthDialog({ welcome: true });
}

/** Cierra la sesión: el visitante pasa a ser invitado. */
export async function logout() {
  const name = select.currentUser()?.firstName ?? '';
  await actions.logout();
  toast(`Has cerrado sesión${name ? `, ${name}` : ''}. Ahora navegas como invitado.`, { tone: 'info' });
}

// Cualquier acción que la API rechace por falta de sesión abre este cuadro.
setAuthRequiredHandler((message) => openAuthDialog({ reason: message }));
