/**
 * Hora de parede no fuso do negocio.
 *
 * BUG QUE ISTO RESOLVE: a API roda com TZ=UTC em producao (proposital — ver
 * docker-compose.prod.yml: timestamps em UTC evitam o timer do PIX abrir ja
 * expirado no app). Mas horario de funcionamento da loja e grade de
 * agendamento sao cadastrados pelo vendedor em hora de PAREDE brasileira
 * ("08:00" as "18:00"). O codigo comparava esses valores com
 * `new Date().getHours()`, que em producao devolve UTC — 3h a mais.
 *
 * Consequencia real: loja configurada 08:00-18:00 so aceitava pedido das
 * 05:00 as 15:00 BRT. As 16:00 (pico!) todo pedido era recusado com
 * "esta loja so aceita pedidos das 08:00 as 18:00", e pedidos as 05:30
 * (loja fechada) passavam. Nos agendamentos, a manha inteira sumia da grade
 * e depois das 21:00 nao dava para agendar para o proprio dia.
 *
 * A correcao NAO muda o TZ do processo (o que quebraria os timestamps) —
 * apenas converte o instante atual para a hora de parede do fuso do negocio
 * na hora de comparar com o que o vendedor cadastrou.
 */

export const BUSINESS_TIMEZONE =
  process.env.BUSINESS_TIMEZONE || 'America/Sao_Paulo';

/** "HH:MM" no fuso do negocio. */
export function businessClock(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BUSINESS_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

/** Minutos desde a meia-noite no fuso do negocio. */
export function businessMinutes(now: Date = new Date()): number {
  const [h, m] = businessClock(now).split(':').map(Number);
  return h * 60 + m;
}

/** "YYYY-MM-DD" de hoje no fuso do negocio. */
export function businessToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Date na meia-noite (UTC) do dia de hoje no fuso do negocio — para comparar datas. */
export function businessTodayDate(now: Date = new Date()): Date {
  return new Date(`${businessToday(now)}T00:00:00.000Z`);
}
