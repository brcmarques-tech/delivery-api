import { OtpService } from './otp.service';
import { MemoriaOtpStore } from './otp-store';

// KAN-280: o fallback de OTP entregava o codigo do TELEFONE a um fallbackEmail
// arbitrario, mas o app verificava pelo TELEFONE — quem pedia o codigo do numero
// de outra pessoa (informando o proprio email) validava a posse do telefone
// alheio (takeover de numero). Correcao: quando o WhatsApp falha, o fallback
// verifica o E-MAIL (canal que de fato recebe), nunca o telefone.

function makeService(whatsappOk: boolean) {
  const whatsAppService = { sendText: jest.fn(async () => whatsappOk) } as any;
  const mailService = { sendVerificationCode: jest.fn(async () => undefined) } as any;
  // KAN-295: o store virou dependencia. Aqui entra o de MEMORIA: o teste
  // unitario nao deve exigir Redis no ar, e o store de memoria tem exatamente
  // o comportamento que estes testes sempre exercitaram.
  const svc = new OtpService(whatsAppService, mailService, new MemoriaOtpStore());
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
    await expect(svc.verifyPhoneCode('5553988887777', codigoEnviado)).rejects.toThrow();
    await expect(svc.consumePhoneVerification('5553988887777')).resolves.toBe(false);

    // o mesmo codigo verifica o E-MAIL (canal que de fato recebeu) — fluxo legitimo
    await expect(svc.verifyEmailCode('atacante@mail.com', codigoEnviado)).resolves.toBe(true);
    await expect(svc.consumeEmailVerification('atacante@mail.com')).resolves.toBe(true);
  });

  // ─── KAN-295: as regras que a troca de store poderia ter perdido ───────────
  //
  // Cada uma destas e conquista de um bug anterior (KAN-280/231). Elas nao
  // estavam cobertas por teste: a migracao para Redis podia desfazer qualquer
  // uma sem nada reclamar.
  it('prova de verificacao e de USO UNICO', async () => {
    const { svc, mailService } = makeService(false);
    await svc.sendPhoneCode('5553911112222', 'dono@mail.com');
    const codigo = mailService.sendVerificationCode.mock.calls[0][1];
    await expect(svc.verifyEmailCode('dono@mail.com', codigo)).resolves.toBe(true);
    await expect(svc.consumeEmailVerification('dono@mail.com')).resolves.toBe(true);
    // segunda vez nao vale: senao um cadastro so verificado serviria para N
    await expect(svc.consumeEmailVerification('dono@mail.com')).resolves.toBe(false);
  });

  it('cooldown de 60s vale para o reenvio', async () => {
    const { svc } = makeService(true);
    await svc.sendPhoneCode('5553922223333');
    await expect(svc.sendPhoneCode('5553922223333')).rejects.toThrow(/60 segundos/);
  });

  it('5 palpites errados bloqueiam, e o 6o ENVENENA o codigo sem zerar o cooldown', async () => {
    const { svc, whatsAppService } = makeService(true);
    await svc.sendPhoneCode('5553933334444');
    const certo = String(whatsAppService.sendText.mock.calls[0][1]).match(/\*(\d{6})\*/)![1];

    for (let i = 0; i < 5; i++) {
      await expect(svc.verifyPhoneCode('5553933334444', '000000')).rejects.toThrow(/incorreto/);
    }
    // 6a tentativa: bloqueio
    await expect(svc.verifyPhoneCode('5553933334444', '000000')).rejects.toThrow(/Muitas tentativas/);
    // e agora NEM o codigo certo passa (entrada envenenada, nao apagada)
    await expect(svc.verifyPhoneCode('5553933334444', certo)).rejects.toThrow();
    // o cooldown segue armado: forca bruta nao se renova pedindo codigo novo
    await expect(svc.sendPhoneCode('5553933334444')).rejects.toThrow(/60 segundos/);
  });

  it('WhatsApp falha sem fallback: lanca e nao deixa telefone verificavel', async () => {
    const { svc } = makeService(false);
    await expect(svc.sendPhoneCode('5553977776666')).rejects.toThrow();
    await expect(svc.consumePhoneVerification('5553977776666')).resolves.toBe(false);
  });
});
