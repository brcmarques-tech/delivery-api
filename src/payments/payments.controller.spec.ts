import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

describe('PaymentsController', () => {
  let controller: PaymentsController;
  let paymentsService: any;

  const mockPaymentsService = {
    handleWebhook: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const map: Record<string, string> = {
        VENDOR_APP_URL: 'http://localhost:3001',
        PAGARME_WEBHOOK_USER: 'testuser',
        PAGARME_WEBHOOK_PASS: 'testpass',
      };
      return map[key] || '';
    }),
  };

  const validAuthHeader = 'Basic ' + Buffer.from('testuser:testpass').toString('base64');

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

  describe('POST /payments/webhook', () => {
    it('should call paymentsService.handleWebhook and return ok', async () => {
      const body = { type: 'order.paid', data: { id: 'or_123' } };
      paymentsService.handleWebhook.mockResolvedValue(undefined);

      const result = await controller.handleWebhook(body, validAuthHeader);

      expect(result).toEqual({ ok: true });
      expect(paymentsService.handleWebhook).toHaveBeenCalledWith(body);
    });

    it('should reject invalid credentials', async () => {
      await expect(
        controller.handleWebhook({ type: 'order.paid', data: { id: 'or_1' } }, 'Basic bad'),
      ).rejects.toThrow('Invalid webhook credentials');
    });

    it('should propagate errors from service', async () => {
      paymentsService.handleWebhook.mockRejectedValue(new Error('bad webhook'));
      await expect(
        controller.handleWebhook({ type: 'order.paid', data: { id: 'or_1' } }, validAuthHeader),
      ).rejects.toThrow('bad webhook');
    });
  });

  describe('GET /payments/order-result', () => {
    it('should redirect to app deep link with sanitized status and order', async () => {
      const mockRes = { redirect: jest.fn() };
      await controller.orderResult('success', 'order-123', mockRes as any);
      expect(mockRes.redirect).toHaveBeenCalledWith(
        'shopping-app://order-result?status=success&order=order-123',
      );
    });

    it('should handle missing params with defaults', async () => {
      const mockRes = { redirect: jest.fn() };
      await controller.orderResult(undefined as any, undefined as any, mockRes as any);
      expect(mockRes.redirect).toHaveBeenCalledWith(
        'shopping-app://order-result?status=unknown&order=',
      );
    });

    it('should sanitize malicious params', async () => {
      const mockRes = { redirect: jest.fn() };
      await controller.orderResult('<script>alert(1)</script>', '../admin', mockRes as any);
      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.not.stringContaining('<script>'),
      );
    });
  });
});
