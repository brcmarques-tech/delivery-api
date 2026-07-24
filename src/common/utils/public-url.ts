import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * KAN-258: varias rotinas montavam links que vao PARA FORA (e-mail de reset de
 * senha, WhatsApp, confirmacao de exclusao de loja) com o padrao
 * `configService.get('APP_URL', 'http://localhost:3000')`.
 *
 * O fallback e silencioso: se a variavel faltar no deploy, o sistema continua
 * funcionando normalmente e simplesmente envia para o usuario final um link
 * `http://localhost:3000/...` — que nunca abre, e sem nenhum sinal no log de
 * que a causa foi configuracao ausente.
 *
 * Aqui o fallback de desenvolvimento continua igual, mas em producao a falta da
 * variavel vira erro no log (uma vez por variavel, para nao inundar) e cai no
 * dominio publico conhecido em vez de localhost.
 */

const logger = new Logger('PublicUrl');
const alreadyWarned = new Set<string>();

/** Dominios publicos conhecidos, usados so quando a env falta em producao. */
const PRODUCTION_FALLBACKS: Record<string, string> = {
  APP_URL: 'https://api.bcmtech.com.br',
  VENDOR_APP_URL: 'https://shopping.bcmtech.com.br',
  VENDOR_PANEL_URL: 'https://shopping.bcmtech.com.br',
  SUPERADMIN_URL: 'https://adminshopping.bcmtech.com.br',
};

export function resolvePublicUrl(
  config: ConfigService,
  key: string,
  devFallback: string,
): string {
  const fromEnv = config.get<string>(key);
  if (fromEnv) return fromEnv;

  if (process.env.NODE_ENV === 'production') {
    const fallback = PRODUCTION_FALLBACKS[key] ?? devFallback;
    if (!alreadyWarned.has(key)) {
      alreadyWarned.add(key);
      logger.error(
        `${key} nao definida em producao — links enviados ao usuario apontariam para ${devFallback}. Usando ${fallback}. Configure a variavel no deploy.`,
      );
    }
    return fallback;
  }

  return devFallback;
}
