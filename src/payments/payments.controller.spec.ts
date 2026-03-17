import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

describe('PaymentsController', () => {
  let controller: PaymentsController;
  let paymentsService: any;

  const mockPaymentsService = {
    handleWebhook: jest.fn(),
    getMpConnectUrl: jest.fn(),
    handleMpOAuthCallback: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const map: Record<string, string> = {
        VENDOR_APP_URL: 'http://localhost:3001',
      };
      return map[key] || '';
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        { provide: PaymentsService, useValue: mockPaymentsService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get<PaymentsController>(PaymentsController);
    paymentsService = mockPaymentsService;
  });

  // ─── handleWebhook ──────────────────────────────────────────
  describe('POST /payments/webhook', () => {
    it('should call paymentsService.handleWebhook and return ok', async () => {
      const body = { type: 'payment', action: 'payment.created', data: { id: 123 } };
      paymentsService.handleWebhook.mockResolvedValue(undefined);

      const result = await controller.handleWebhook(body);

      expect(result).toEqual({ ok: true });
      expect(paymentsService.handleWebhook).toHaveBeenCalledWith(body);
    });

    it('should propagate errors from service', async () => {
      paymentsService.handleWebhook.mockRejectedValue(new Error('bad webhook'));
      await expect(
        controller.handleWebhook({ type: 'payment', action: 'payment.created', data: { id: 1 } }),
      ).rejects.toThrow('bad webhook');
    });
  });

  // ─── getMpConnectUrl ────────────────────────────────────────
  describe('GET /payments/mp/connect-url', () => {
    it('should return MP connect URL', () => {
      paymentsService.getMpConnectUrl.mockReturnValue('https://auth.mercadopago.com.br/authorization?client_id=123');
      const result = controller.getMpConnectUrl('user-1');
      expect(result).toEqual({ url: 'https://auth.mercadopago.com.br/authorization?client_id=123' });
    });
  });

  // ─── orderResult ────────────────────────────────────────────
  describe('GET /payments/order-result', () => {
    it('should redirect to app deep link with status and order', async () => {
      const mockRes = {
        redirect: jest.fn(),
      };

      await controller.orderResult('success', 'order-123', mockRes as any);

      expect(mockRes.redirect).toHaveBeenCalledWith(
        'delivery-app://order-result?status=success&order=order-123',
      );
    });

    it('should handle missing params with defaults', async () => {
      const mockRes = { redirect: jest.fn() };
      await controller.orderResult(undefined as any, undefined as any, mockRes as any);
      expect(mockRes.redirect).toHaveBeenCalledWith(
        'delivery-app://order-result?status=unknown&order=',
      );
    });
  });

  // ─── handleMpCallback ──────────────────────────────────────
  describe('GET /payments/mp/callback', () => {
    it('should handle vendor OAuth callback and redirect to vendor panel', async () => {
      const mockRes = { redirect: jest.fn() };
      paymentsService.handleMpOAuthCallback.mockResolvedValue(undefined);

      await controller.handleMpCallback('auth-code-123', 'vendor-1:web', mockRes as any);

      expect(paymentsService.handleMpOAuthCallback).toHaveBeenCalledWith(
        'auth-code-123',
        'vendor-1',
        'vendor',
      );
      expect(mockRes.redirect).toHaveBeenCalledWith(
        'http://localhost:3001/dashboard?mp=connected',
      );
    });

    it('should handle app OAuth callback and redirect to app deep link', async () => {
      const mockRes = { redirect: jest.fn() };
      paymentsService.handleMpOAuthCallback.mockResolvedValue(undefined);

      await controller.handleMpCallback('auth-code-456', 'deliverer-1:app', mockRes as any);

      expect(paymentsService.handleMpOAuthCallback).toHaveBeenCalledWith(
        'auth-code-456',
        'deliverer-1',
        'app',
      );
      expect(mockRes.redirect).toHaveBeenCalledWith('delivery-app://profile?mp=connected');
    });
  });
});
