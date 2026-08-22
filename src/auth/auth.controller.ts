import { Controller, Get, Post, Query, Body, Res, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as express from 'express';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import { fetchWithTimeout } from '../common/utils/fetch-with-timeout'; // KAN-253

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private configService: ConfigService,
    private jwtService: JwtService,
  ) {}

  /**
   * Destinos permitidos para o `returnUrl` do login social.
   *
   * CRITICO: o `returnUrl` chegava cru da query string publica, era assinado
   * dentro do `state` e o callback redirecionava para ele COM O ACCESS_TOKEN DO
   * GOOGLE na query. Assinar o state garante integridade, nao legitimidade — o
   * valor era escolhido pelo proprio atacante. Bastava mandar para a vitima
   * `/auth/google/mobile?returnUrl=https://evil.com/x`: ela via a tela legitima
   * do Google, no dominio legitimo da API, e no fim o navegador dela era
   * redirecionado para o atacante carregando o token. Como `verifyGoogleToken`
   * aceita access_token, o atacante trocava aquilo por um JWT de 7 dias da conta
   * — tomada de conta em um clique. Agora so redirecionamos para destinos que a
   * propria plataforma declara.
   */
  private returnUrlPermitida(candidata?: string): string {
    const padrao = 'shopping-app://google-auth';
    if (!candidata) return padrao;

    const permitidos = [
      padrao,
      'shopping-vendor://google-auth',
      this.configService.get('VENDOR_APP_URL'),
      this.configService.get('SUPERADMIN_URL'),
      this.configService.get('STOREFRONT_URL'),
      ...String(this.configService.get('OAUTH_RETURN_ALLOWLIST') || '')
        .split(',')
        .map((s) => s.trim()),
    ].filter(Boolean) as string[];

    const limpa = candidata.replace(/\?.*$/, '');

    for (const permitido of permitidos) {
      // Deep link: precisa bater exatamente (esquema custom nao tem origem).
      if (permitido.includes('://') && !permitido.startsWith('http')) {
        if (limpa === permitido) return limpa;
        continue;
      }
      // Web: mesma origem (esquema + host + porta), caminho livre.
      try {
        const alvo = new URL(limpa);
        const base = new URL(permitido);
        if (alvo.origin === base.origin) return limpa;
      } catch {
        // candidata nao e URL absoluta valida — segue para o proximo
      }
    }
    return padrao;
  }

  @Get('reset-password')
  async resetPasswordPage(
    @Query('token') token: string,
    @Query('type') type: string,
    @Res() res: express.Response,
  ) {
    if (!token) {
      return res.status(400).send(this.renderHtml('Erro', 'Token nao fornecido.', true));
    }
    return res.send(this.renderHtml('Redefinir Senha', '', false, token, type || 'app'));
  }

  @Post('reset-password')
  async resetPasswordSubmit(
    @Body('token') token: string,
    @Body('newPassword') newPassword: string,
    @Body('confirmPassword') confirmPassword: string,
    @Body('type') type: string,
    @Res() res: express.Response,
  ) {
    if (!token) {
      return res.status(400).send(this.renderHtml('Erro', 'Token nao fornecido.', true));
    }
    if (!newPassword || newPassword.length < 6) {
      return res.send(this.renderHtml('Redefinir Senha', 'A senha deve ter pelo menos 6 caracteres.', false, token, type));
    }
    if (newPassword !== confirmPassword) {
      return res.send(this.renderHtml('Redefinir Senha', 'As senhas nao coincidem.', false, token, type));
    }

    try {
      if (type === 'vendor') {
        await this.authService.resetPasswordVendor(token, newPassword);
      } else {
        await this.authService.resetPasswordApp(token, newPassword);
      }
      return res.send(this.renderHtml('Senha alterada!', 'Sua senha foi alterada com sucesso. Voce ja pode fazer login no aplicativo.', true));
    } catch (err: any) {
      const msg = err?.message || 'Erro ao redefinir senha.';
      return res.send(this.renderHtml('Redefinir Senha', msg, false, token, type));
    }
  }

  // ---- Google OAuth for Mobile ----

  @Get('google/mobile')
  async googleMobileStart(
    @Query('mode') mode: string,
    @Query('userType') userType: string,
    @Query('returnUrl') returnUrl: string,
    @Res() res: express.Response,
  ) {
    const clientId = this.configService.get('GOOGLE_CLIENT_ID');
    const appUrl = this.configService.get('APP_URL');
    const state = this.jwtService.sign(
      {
        mode: mode || 'login',
        userType: userType || 'app',
        // Valida na ENTRADA: um returnUrl hostil nunca chega a ser assinado.
        returnUrl: this.returnUrlPermitida(returnUrl),
      },
      { expiresIn: '10m' },
    );
    const redirectUri = `${appUrl}/auth/google/mobile/callback`;
    const url =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=openid+profile+email` +
      `&state=${state}` +
      `&access_type=offline` +
      `&prompt=select_account`;
    return res.redirect(url);
  }

  @Get('google/mobile/callback')
  async googleMobileCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: express.Response,
  ) {
    if (error || !code) {
      return res.redirect(`shopping-app://google-auth?error=${error || 'no_code'}`);
    }

    let statePayload: any;
    try {
      statePayload = this.jwtService.verify(state);
    } catch {
      return res.redirect(`shopping-app://google-auth?error=invalid_state`);
    }

    const { mode, userType, returnUrl } = statePayload;
    // Revalida na SAIDA tambem: states assinados antes desta correcao seguem
    // validos por ate 10 minutos e poderiam carregar um destino hostil.
    const baseReturnUrl = this.returnUrlPermitida(returnUrl);
    const clientId = this.configService.get('GOOGLE_CLIENT_ID');
    const clientSecret = this.configService.get('GOOGLE_CLIENT_SECRET');
    const appUrl = this.configService.get('APP_URL');
    const redirectUri = `${appUrl}/auth/google/mobile/callback`;

    try {
      // Exchange code for tokens
      const tokenRes = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) {
        return res.redirect(`${baseReturnUrl}?error=token_exchange_failed`);
      }

      // Get user info
      const userInfoRes = await fetchWithTimeout('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const userInfo = await userInfoRes.json();

      if (mode === 'register') {
        // Registration: return user info so the app can collect phone/CPF
        const params = new URLSearchParams({
          mode: 'register',
          name: userInfo.name || '',
          email: userInfo.email || '',
          googleId: userInfo.sub || '',
          emailVerified: userInfo.email_verified ? 'true' : 'false',
          accessToken: tokens.access_token,
        });
        return res.redirect(`${baseReturnUrl}?${params.toString()}`);
      }

      // Login mode: return Google access token so the client can authenticate via GraphQL
      const params = new URLSearchParams({
        mode: 'login',
        accessToken: tokens.access_token,
      });
      return res.redirect(`${baseReturnUrl}?${params.toString()}`);
    } catch (err: any) {
      const msg = err?.message || 'unknown_error';
      return res.redirect(`${baseReturnUrl}?error=${encodeURIComponent(msg)}`);
    }
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private renderHtml(title: string, message: string, isResult: boolean, token?: string, type?: string): string {
    const safeToken = this.escapeHtml(token || '');
    const safeType = this.escapeHtml(type || 'app');
    return `<!DOCTYPE html>
<html lang="pt-BR"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - bcmTech Shopping</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%23FF6B35'/><text x='50' y='72' font-size='60' font-weight='bold' font-family='Arial' fill='white' text-anchor='middle'>B</text></svg>">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); width: 100%; max-width: 420px; overflow: hidden; }
    .header { background: #F97316; padding: 24px; text-align: center; }
    .header h1 { color: white; font-size: 20px; font-weight: 700; }
    .body { padding: 32px 24px; }
    .body h2 { color: #2D3436; font-size: 22px; margin-bottom: 8px; text-align: center; }
    .error { background: #FEF2F2; color: #DC2626; padding: 12px; border-radius: 10px; font-size: 14px; margin-bottom: 16px; text-align: center; }
    .success { background: #F0FDF4; color: #16A34A; padding: 16px; border-radius: 10px; font-size: 15px; text-align: center; line-height: 1.5; }
    .field { margin-bottom: 16px; }
    .field label { display: block; font-size: 13px; color: #666; margin-bottom: 6px; font-weight: 500; }
    .field input { width: 100%; padding: 14px 16px; border: 1px solid #E5E7EB; border-radius: 12px; font-size: 16px; color: #333; outline: none; transition: border-color 0.2s; }
    .field input:focus { border-color: #F97316; }
    .btn { width: 100%; padding: 14px; background: #F97316; color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 700; cursor: pointer; transition: background 0.2s; }
    .btn:hover { background: #EA580C; }
    .btn:active { transform: scale(0.98); }
    .footer { text-align: center; padding: 16px 24px 24px; font-size: 12px; color: #999; }
  </style>
</head><body>
  <div class="card">
    <div class="header"><h1>bcmTech Shopping</h1></div>
    <div class="body">
      <h2>${title}</h2>
      ${isResult ? `<div class="success" style="margin-top: 16px;">${message}</div>` : `
        ${message ? `<div class="error">${message}</div>` : ''}
        <form method="POST" action="/auth/reset-password" style="margin-top: 16px;">
          <input type="hidden" name="token" value="${safeToken}">
          <input type="hidden" name="type" value="${safeType}">
          <div class="field">
            <label>Nova senha</label>
            <input type="password" name="newPassword" placeholder="Minimo 6 caracteres" required minlength="6">
          </div>
          <div class="field">
            <label>Confirmar senha</label>
            <input type="password" name="confirmPassword" placeholder="Repita a senha" required minlength="6">
          </div>
          <button type="submit" class="btn">Redefinir Senha</button>
        </form>
      `}
    </div>
    <div class="footer">bcmTech Shopping - Arroio Grande, RS</div>
  </div>
</body></html>`;
  }
}
