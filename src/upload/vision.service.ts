import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImageAnnotatorClient } from '@google-cloud/vision';

@Injectable()
export class VisionService {
  private readonly logger = new Logger(VisionService.name);
  private client: ImageAnnotatorClient | null = null;

  constructor(private configService: ConfigService) {
    const credentials = this.configService.get('GOOGLE_VISION_CREDENTIALS');
    if (credentials) {
      try {
        const parsed = JSON.parse(
          Buffer.from(credentials, 'base64').toString('utf-8'),
        );
        this.client = new ImageAnnotatorClient({ credentials: parsed });
        this.logger.log('Google Vision inicializado');
      } catch {
        this.logger.warn('Falha ao parsear GOOGLE_VISION_CREDENTIALS');
      }
    } else if (process.env.NODE_ENV === 'production') {
      // KAN-230: em producao isso e um defeito de configuracao, nao um aviso.
      this.logger.error(
        'GOOGLE_VISION_CREDENTIALS nao configurado em PRODUCAO — KYC automatico de entregador DESLIGADO',
      );
    } else {
      this.logger.warn(
        'GOOGLE_VISION_CREDENTIALS nao configurado - validacao de fotos desabilitada',
      );
    }
  }

  /**
   * O SDK do Vision decide entre URL remota e ARQUIVO LOCAL olhando a string:
   * sem `://` (ou com `file://`) ele trata como `source.filename` e faz
   * `fs.readFile` no disco da API, mandando o conteudo em base64 para o Google.
   * Como `imageUrl` chega cru do cliente nas duas mutations (protegidas apenas
   * por GqlAuthGuard, ou seja, qualquer conta comum), isso permitia:
   *   - `validateDocumentPhoto(imageUrl: "/app/.env")` -> le segredos do
   *     servidor e os transmite para fora do perimetro;
   *   - `validateFacePhoto(imageUrl: "/dev/zero")` -> readFile infinito, OOM,
   *     API derrubada por um unico usuario logado;
   *   - `gs://bucket-privado/objeto` -> contem `://`, entao vira imageUri e o
   *     Vision le o objeto com as credenciais da plataforma.
   * As fotos legitimas SEMPRE vem do upload da propria plataforma, entao exigir
   * https no host do Cloudinary nao restringe nenhum uso real.
   */
  private assertImagemPermitida(imageUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
    } catch {
      throw new BadRequestException('URL de imagem invalida.');
    }
    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('URL de imagem invalida.');
    }
    const permitidos = (
      this.configService.get<string>('IMAGE_HOST_ALLOWLIST') ||
      'res.cloudinary.com'
    )
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (!permitidos.includes(parsed.hostname.toLowerCase())) {
      this.logger.warn(
        `Host de imagem recusado na validacao: ${parsed.hostname}`,
      );
      throw new BadRequestException('URL de imagem invalida.');
    }
  }

  /**
   * KAN-230: quando o Vision nao esta disponivel, a validacao NAO deve se
   * passar por uma aprovacao. Antes retornava `{ valid: true }`, indistinguivel
   * de uma checagem real — se a credencial caisse ou expirasse, o KYC de
   * entregador parava de existir sem nenhum alarme.
   *
   * Agora: continua deixando o cadastro seguir (a aprovacao final e manual do
   * SUPERADMIN, entao bloquear aqui derrubaria o onboarding inteiro por uma
   * falha de config), mas marca `requiresManualReview` e loga em nivel de ERRO
   * em producao, para virar alerta em vez de silencio.
   */
  private unavailable(): { valid: boolean; message: string; requiresManualReview: boolean } {
    const msg = 'Validacao automatica indisponivel — sera revisada manualmente';
    if (process.env.NODE_ENV === 'production') {
      this.logger.error(
        'GOOGLE_VISION_CREDENTIALS ausente/invalido em PRODUCAO — KYC automatico DESLIGADO. Fotos seguem para revisao manual.',
      );
    } else {
      this.logger.warn('Vision nao configurado — foto marcada para revisao manual');
    }
    return { valid: true, message: msg, requiresManualReview: true };
  }

  async validateFacePhoto(
    imageUrl: string,
  ): Promise<{ valid: boolean; message: string; requiresManualReview?: boolean }> {
    if (!this.client) return this.unavailable();

    this.assertImagemPermitida(imageUrl);

    try {
      const [result] = await this.client.faceDetection(imageUrl);
      const faces = result.faceAnnotations || [];

      if (faces.length === 0) {
        return { valid: false, message: 'Nenhum rosto detectado na foto. Tire uma selfie mostrando seu rosto claramente.' };
      }

      if (faces.length > 1) {
        return { valid: false, message: 'Mais de um rosto detectado. A selfie deve conter apenas o seu rosto.' };
      }

      const face = faces[0];
      const confidence = face.detectionConfidence || 0;

      if (confidence < 0.7) {
        return { valid: false, message: 'Rosto nao detectado com clareza. Tire a foto em um ambiente bem iluminado.' };
      }

      this.logger.log(`Rosto validado com confianca: ${(confidence * 100).toFixed(1)}%`);
      return { valid: true, message: 'Rosto detectado com sucesso' };
    } catch (error) {
      this.logger.error('Erro na validacao facial', error);
      return { valid: false, message: 'Erro na validacao facial. Tente novamente.' };
    }
  }

  async validateDocumentPhoto(
    imageUrl: string,
  ): Promise<{ valid: boolean; message: string; requiresManualReview?: boolean }> {
    if (!this.client) return this.unavailable();

    this.assertImagemPermitida(imageUrl);

    try {
      const [result] = await this.client.textDetection(imageUrl);
      const texts = result.textAnnotations || [];

      if (texts.length < 3) {
        return { valid: false, message: 'Documento nao reconhecido. Tire uma foto clara do seu documento (CNH ou RG).' };
      }

      const fullText = (texts[0]?.description || '').toUpperCase();
      // BUGFIX: o match era por substring (includes) — 'RG' casava dentro de
      // ORGAO/MARGEM/SERGIO, 'DATA'/'NOME'/'BRASIL' aparecem em qualquer
      // formulario — e o limiar era 2 termos genericos, entao um papel qualquer
      // com "NOME" e uma data passava como documento. Agora: match por PALAVRA
      // INTEIRA e exige (a) pelo menos um termo DISCRIMINANTE de documento e (b)
      // pelo menos 2 termos no total. (Continua advisorio — o gate real e a
      // aprovacao manual do superadmin; ver KYC 3.8.)
      const temPalavra = (kw: string) =>
        new RegExp(`(^|[^A-Z0-9])${kw}([^A-Z0-9]|$)`).test(fullText);

      // termos que so aparecem de fato num documento de identidade/habilitacao
      const discriminantes = [
        'HABILITACAO', 'CNH', 'IDENTIDADE', 'FEDERATIVA',
        'EXPEDIDOR', 'DETRAN', 'SSP',
      ];
      // termos de apoio (comuns, mas somam evidencia)
      const apoio = [
        'REPUBLICA', 'BRASIL', 'CARTEIRA', 'REGISTRO', 'GERAL',
        'CPF', 'RG', 'NOME', 'NASCIMENTO', 'DATA', 'VALIDADE',
        'CATEGORIA', 'ORGAO', 'NACIONAL',
      ];

      const temDiscriminante = discriminantes.some(temPalavra);
      const matched = [...discriminantes, ...apoio].filter(temPalavra);

      if (!temDiscriminante || matched.length < 2) {
        return { valid: false, message: 'Documento nao reconhecido. Envie uma foto clara da sua CNH ou RG.' };
      }

      this.logger.log(`Documento validado - palavras-chave: ${matched.join(', ')}`);
      return { valid: true, message: 'Documento reconhecido com sucesso' };
    } catch (error) {
      this.logger.error('Erro na validacao do documento', error);
      return { valid: false, message: 'Erro na validacao do documento. Tente novamente.' };
    }
  }
}
