import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import * as express from 'express';
import { StoresService } from './stores.service';

const FAVICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%23FF6B35'/><text x='50' y='72' font-size='60' font-weight='bold' font-family='Arial' fill='white' text-anchor='middle'>B</text></svg>">`;

/** Escapa o token antes de injetar no HTML (vem da query string). */
function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title: string, inner: string): string {
  return `
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="robots" content="noindex, nofollow" />
        <title>${title}</title>
        ${FAVICON}
      </head>
      <body style="font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e;">
        <div style="text-align: center; max-width: 420px; padding: 40px; background: #16213e; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
          ${inner}
        </div>
      </body>
    </html>
  `;
}

@Controller('stores')
export class StoresController {
  constructor(private storesService: StoresService) {}

  /**
   * KAN-229: este GET agora é IDEMPOTENTE — apenas renderiza a página com o
   * botão de confirmação. Antes ele próprio chamava `confirmStoreDelete()`,
   * que faz `remove()` (hard delete). Como GET é pré-buscado por clientes de
   * e-mail, antivírus e proxies, bastava o link ser varrido para a loja ser
   * apagada em definitivo, sem ninguém clicar. A exclusão passou para o POST.
   */
  @Get('confirm-delete')
  confirmDeletePage(@Query('token') token: string, @Res() res: express.Response) {
    const safeToken = escapeHtml(token);
    res.send(
      page(
        'Confirmar exclusao da loja',
        `
          <div style="font-size: 48px; margin-bottom: 16px;">&#9888;</div>
          <h2 style="color: #E67E22; margin-bottom: 8px;">Confirmar exclusao</h2>
          <p style="color: #a0a0a0; font-size: 14px;">
            Esta acao remove a loja <strong style="color:#fff;">permanentemente</strong> e nao pode ser desfeita.
          </p>
          <form method="POST" action="/stores/confirm-delete" style="margin-top: 24px;">
            <input type="hidden" name="token" value="${safeToken}" />
            <button type="submit"
              style="background:#E74C3C;color:#fff;border:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;">
              Sim, excluir minha loja
            </button>
          </form>
          <p style="color: #666; font-size: 12px; margin-top: 20px;">
            Se voce nao solicitou isso, basta fechar esta pagina.
          </p>
        `,
      ),
    );
  }

  @Post('confirm-delete')
  async confirmDelete(
    @Body('token') bodyToken: string,
    @Query('token') queryToken: string,
    @Res() res: express.Response,
  ) {
    const token = bodyToken || queryToken;
    try {
      const storeName = await this.storesService.confirmStoreDelete(token);
      res.send(
        page(
          'Loja excluida',
          `
            <div style="font-size: 48px; margin-bottom: 16px;">&#10003;</div>
            <h2 style="color: #27AE60; margin-bottom: 8px;">Loja excluida com sucesso</h2>
            <p style="color: #a0a0a0; font-size: 14px;">A loja <strong style="color: #fff;">"${escapeHtml(storeName)}"</strong> foi removida permanentemente.</p>
            <p style="color: #666; font-size: 12px; margin-top: 20px;">Voce ja pode fechar esta pagina.</p>
          `,
        ),
      );
    } catch (error: any) {
      res.status(400).send(
        page(
          'Erro',
          `
            <div style="font-size: 48px; margin-bottom: 16px;">&#10007;</div>
            <h2 style="color: #E74C3C; margin-bottom: 8px;">Erro ao excluir loja</h2>
            <p style="color: #a0a0a0; font-size: 14px;">${escapeHtml(error?.message || 'Token invalido ou expirado.')}</p>
          `,
        ),
      );
    }
  }
}
