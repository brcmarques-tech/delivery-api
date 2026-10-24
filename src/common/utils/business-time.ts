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

/**
 * Instante EXATO em que o dia comercial começou, no fuso do negócio.
 *
 * `businessTodayDate()` devolve meia-noite **UTC** da data brasileira — para
 * 15/10 isso é `2026-10-15T00:00:00Z`, que em Brasília é **14/10 às 21:00**.
 * Contra uma data pura (o `scheduledDate` dos agendamentos) isso é inofensivo,
 * e é por isso que lá a função está correta. Mas contra um TIMESTAMP
 * (`createdAt`) o corte do dia fica 3 horas adiantado: todo pedido feito entre
 * 21:00 e meia-noite — justamente o pico do delivery — era contado DUAS vezes,
 * no resumo de ontem e de novo no de hoje.
 *
 * O offset é descoberto via Intl, não fixado em -03:00: assim continua certo se
 * o país voltar a ter horário de verão ou se o fuso do negócio mudar.
 */
export function businessDayStartInstant(now: Date = new Date()): Date {
  const dia = businessToday(now); // 'YYYY-MM-DD' já no fuso do negócio
  const palpite = new Date(`${dia}T00:00:00.000Z`);
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(palpite);
  const v = (t: string) => Number(partes.find((p) => p.type === t)?.value ?? 0);
  const comoSeFosseUtc = Date.UTC(
    v('year'),
    v('month') - 1,
    v('day'),
    v('hour'),
    v('minute'),
    v('second'),
  );
  const offset = comoSeFosseUtc - palpite.getTime();
  return new Date(palpite.getTime() - offset);
}
