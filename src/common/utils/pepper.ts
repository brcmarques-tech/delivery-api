export function peppered(password: string): string {
  return password + (process.env.PASSWORD_PEPPER || '');
}
