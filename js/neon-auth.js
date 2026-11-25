/**
 * neon-auth.js
 * ---------------------------------------------------------------------------
 * Cliente mínimo de Neon Auth (Managed Better Auth) para el navegador.
 *
 * Las cuentas se guardan en la base de datos de Neon (tabla neon_auth.user)
 * y las contraseñas las cifra y comprueba el servidor de Neon. La sesión es
 * una cookie segura del dominio de Neon (HttpOnly, Secure, SameSite=None,
 * Partitioned): la página nunca ve la contraseña guardada ni el token.
 *
 * Se usa la API HTTP de Better Auth directamente con fetch para no cargar el
 * SDK completo (@neon/neon-js, unos 600 KB). Si más adelante se usa también
 * la Data API, se puede sustituir por ese SDK sin tocar el resto de la app.
 *
 * Para que funcione, el dominio de la web debe estar en los dominios de
 * confianza de Neon Auth (Neon Console › Auth › Configuration).
 */

/** Error devuelto por Neon Auth: code es el código de Better Auth (p. ej. INVALID_EMAIL_OR_PASSWORD). */
export class NeonAuthError extends Error {
  constructor(message, { code = 'UNKNOWN', status = 0 } = {}) {
    super(message);
    this.name = 'NeonAuthError';
    this.code = code;
    this.status = status;
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

export class NeonAuthClient {
  /** @param {string} baseUrl  URL de Auth de la rama, p. ej. https://ep-….neonauth….neon.tech/neondb/auth */
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async #request(path, options = {}) {
    return (await this.#send(path, options)).payload;
  }

  /** Hace la petición y devuelve { payload, headers } (algunas respuestas traen el JWT en una cabecera). */
  async #send(path, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        // La cookie de sesión vive en el dominio de Neon: hay que enviarla en cada petición.
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout?.(timeoutMs),
      });
    } catch (error) {
      throw new NeonAuthError(error?.name === 'TimeoutError' ? 'El servidor de cuentas tarda demasiado en responder.' : 'No se pudo conectar con el servidor de cuentas.', { code: 'NETWORK' });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new NeonAuthError(payload?.message ?? `Error ${response.status}`, { code: payload?.code ?? `HTTP_${response.status}`, status: response.status });
    }
    return { payload, headers: response.headers };
  }

  /** Crea la cuenta y deja la sesión iniciada. Devuelve { user }. */
  signUp({ name, email, password }) {
    return this.#request('/sign-up/email', { method: 'POST', body: { name, email, password } });
  }

  /** Inicia sesión. Devuelve { user }. */
  signIn({ email, password }) {
    return this.#request('/sign-in/email', { method: 'POST', body: { email, password, rememberMe: true } });
  }

  /**
   * Sesión actual: { user, session, jwt } o null si no hay sesión. jwt es el
   * token (unos 15 minutos de validez) que pide la Data API de Neon. Se
   * consulta al abrir la página: espera poco.
   */
  async getSession({ timeoutMs = 6_000 } = {}) {
    const { payload, headers } = await this.#send('/get-session', { timeoutMs });
    if (!payload?.user) return null;
    return { ...payload, jwt: headers.get('set-auth-jwt') };
  }

  /** Token anónimo para leer los datos públicos de la Data API sin iniciar sesión. */
  getAnonymousToken() {
    return this.#request('/token/anonymous', { timeoutMs: 8_000 });
  }

  signOut() {
    return this.#request('/sign-out', { method: 'POST', body: {} });
  }

  changePassword({ currentPassword, newPassword }) {
    return this.#request('/change-password', { method: 'POST', body: { currentPassword, newPassword, revokeOtherSessions: false } });
  }

  /** Cambia el nombre visible guardado en Neon. */
  updateUser({ name }) {
    return this.#request('/update-user', { method: 'POST', body: { name } });
  }
}
