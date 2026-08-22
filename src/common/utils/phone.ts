/**
 * Normalização de telefone brasileiro para casar números apesar do "nono
 * dígito" e do código do país. O WhatsApp às vezes devolve o número SEM o 9 do
 * celular (ex.: 555391971031 = 55 + 53 + 91971031), enquanto o cadastro tem o 9
 * (53991971031 = 53 + 9 + 91971031). Aqui geramos as formas equivalentes
 * (com/sem 9, com/sem 55) para uma comparação robusta — mantendo o DDD para não
 * casar números de DDDs diferentes (o problema que a versão "últimos 8 dígitos"
 * causava).
 *
 * Retorna a lista de candidatos em SÓ DÍGITOS. Use com uniqueness (rejeitar se
 * casar mais de um usuário) para não confundir contas.
 */
export function brazilPhoneCandidates(raw: string | null | undefined): string[] {
  let d = (raw || '').replace(/\D/g, '');
  if (!d) return [];
  // tira o país (55) quando presente num número longo
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);

  const set = new Set<string>();
  set.add(d);
  if (d.length >= 10) {
    const ddd = d.slice(0, 2);
    const rest = d.slice(2);
    const last8 = rest.slice(-8);
    set.add(ddd + last8); // sem o 9
    set.add(ddd + '9' + last8); // com o 9
  }
  // acrescenta as variantes com o país
  for (const x of [...set]) set.add('55' + x);
  return [...set];
}
