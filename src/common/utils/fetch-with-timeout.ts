/**
 * KAN-253: `fetch` com timeout.
 *
 * Nenhuma chamada externa do backend definia timeout (Google OAuth, Nominatim,
 * Expo Push, SerpAPI, WAHA, ViaCEP). Como o `fetch` do Node nao tem timeout
 * padrao, uma dependencia lenta segurava a request do usuario indefinidamente —
 * e, num handler de webhook ou de login, isso prende worker e cascateia.
 *
 * As chamadas ja tratam falha (retornam false/[] ou lancam), entao transformar
 * "pendurado" em "erro rapido" e uma melhoria direta de resiliencia.
 *
 * Um abort chega ao chamador como excecao com `name === 'AbortError'`.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 10000;

export async function fetchWithTimeout(
  input: any,
  init?: any,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...(init || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** true se o erro veio de um timeout/abort desta util. */
export function isTimeoutError(err: any): boolean {
  return err?.name === 'AbortError';
}
