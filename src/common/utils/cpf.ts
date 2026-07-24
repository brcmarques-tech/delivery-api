/**
 * KAN-253: validacao de CPF, antes duplicada byte-a-byte em
 * `users/app-users.service.ts` e `users/vendor-users.service.ts`.
 *
 * Duas copias da mesma regra fiscal e um convite a divergencia: qualquer
 * correcao futura precisaria ser lembrada nos dois lugares, e a que ficasse
 * para tras passaria a aceitar (ou recusar) CPFs diferente da outra.
 */
export function isValidCpf(cpf: string): boolean {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  // Rejeita sequencias repetidas (000.000.000-00, 111..., etc.)
  if (/^(\d)\1{10}$/.test(digits)) return false;

  // Primeiro digito verificador
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(digits[i]) * (10 - i);
  let check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (parseInt(digits[9]) !== check) return false;

  // Segundo digito verificador
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(digits[i]) * (11 - i);
  check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (parseInt(digits[10]) !== check) return false;

  return true;
}
