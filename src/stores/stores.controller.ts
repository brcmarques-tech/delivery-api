import { Controller, Get, Query, Res } from '@nestjs/common';
import * as express from 'express';
import { StoresService } from './stores.service';

const FAVICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%23FF6B35'/><text x='50' y='72' font-size='60' font-weight='bold' font-family='Arial' fill='white' text-anchor='middle'>B</text></svg>">`;

@Controller('stores')
export class StoresController {
  constructor(private storesService: StoresService) {}

  @Get('confirm-delete')
  async confirmDelete(
    @Query('token') token: string,
    @Res() res: express.Response,
  ) {
    try {
      const storeName = await this.storesService.confirmStoreDelete(token);
      res.send(`
        <html>
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Loja excluida</title>
            ${FAVICON}
          </head>
          <body style="font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e;">
            <div style="text-align: center; max-width: 400px; padding: 40px; background: #16213e; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
              <div style="font-size: 48px; margin-bottom: 16px;">&#10003;</div>
              <h2 style="color: #27AE60; margin-bottom: 8px;">Loja excluida com sucesso</h2>
              <p style="color: #a0a0a0; font-size: 14px;">A loja <strong style="color: #fff;">"${storeName}"</strong> foi removida permanentemente.</p>
              <p style="color: #666; font-size: 12px; margin-top: 20px;">Voce ja pode fechar esta pagina.</p>
            </div>
          </body>
        </html>
      `);
    } catch (error: any) {
      res.status(400).send(`
        <html>
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Erro</title>
            ${FAVICON}
          </head>
          <body style="font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e;">
            <div style="text-align: center; max-width: 400px; padding: 40px; background: #16213e; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
              <div style="font-size: 48px; margin-bottom: 16px;">&#10007;</div>
              <h2 style="color: #E74C3C; margin-bottom: 8px;">Erro ao excluir loja</h2>
              <p style="color: #a0a0a0; font-size: 14px;">${error.message || 'Token invalido ou expirado.'}</p>
            </div>
          </body>
        </html>
      `);
    }
  }
}
