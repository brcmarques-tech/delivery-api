import { OtpService } from './otp.service';

// KAN-280: o fallback de OTP entregava o codigo do TELEFONE a um fallbackEmail
// arbitrario, mas o app verificava pelo TELEFONE — quem pedia o codigo do numero
// de outra pessoa (informando o proprio email) validava a posse do telefone
// alheio (takeover de numero). Correcao: quando o WhatsApp falha, o fallback
// verifica o E-MAIL (canal que de fato recebe), nunca o telefone.

function makeService(whatsappOk: boolean) {
  const whatsAppService = { sendText: jest.fn(async () => whatsappOk) } as any;
  const mailService = { sendVerificationCode: jest.fn(async () => undefined) } as any;
  const svc = new OtpService(whatsAppService, mailService);
  return { svc, whatsAppService, mailService };
}

describe('OtpService fallback (KAN-280)', () => {
  it('WhatsApp OK: verifica pelo telefone, nao gera codigo de email', async () => {
    const { svc, mailService } = makeService(true);
    const res = await svc.sendPhoneCode('5553999999999', 'dono@mail.com');
    expect(res.method).toBe('whatsapp');
    expect(mailService.sendVerificationCode).not.toHaveBeenCalled();
  });

  it('VETOR: WhatsApp falha -> o codigo NAO valida o telefone (so o email)', async () => {
    const { svc, mailService } = makeService(false);
    const res = await svc.sendPhoneCode('5553988887777', 'atacante@mail.com');
    // caiu para o e-mail
    expect(res.method).toBe('email');
    expect(mailService.sendVerificationCode).toHaveBeenCalledTimes(1);
    // o codigo que o e-mail recebeu foi o argumento da chamada
    const codigoEnviado = mailService.sendVerificationCode.mock.calls[0][1];

    // tentar verificar o TELEFONE com esse codigo DEVE falhar (nao existe entrada
    // de telefone verificavel — era esse o vazamento)
    expect(() => svc.verifyPhoneCode('5553988887777', codigoEnviado)).toThrow();
    expect(svc.consumePhoneVerification('5553988887777')).toBe(false);

    // o mesmo codigo verifica o E-MAIL (canal que de fato recebeu) — fluxo legitimo
    expect(svc.verifyEmailCode('atacante@mail.com', codigoEnviado)).toBe(true);
    expect(svc.consumeEmailVerification('atacante@mail.com')).toBe(true);
  });

  it('WhatsApp falha sem fallback: lanca e nao deixa telefone verificavel', async () => {
    const { svc } = makeService(false);
    await expect(svc.sendPhoneCode('5553977776666')).rejects.toThrow();
    expect(svc.consumePhoneVerification('5553977776666')).toBe(false);
  });
});
