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

    try {
      const [result] = await this.client.textDetection(imageUrl);
      const texts = result.textAnnotations || [];

      if (texts.length < 3) {
        return { valid: false, message: 'Documento nao reconhecido. Tire uma foto clara do seu documento (CNH ou RG).' };
      }

      const fullText = (texts[0]?.description || '').toUpperCase();

      const docKeywords = [
        'REPUBLICA', 'FEDERATIVA', 'BRASIL',
        'HABILITACAO', 'CNH', 'CARTEIRA',
        'IDENTIDADE', 'REGISTRO', 'GERAL',
        'CPF', 'RG', 'NOME', 'NASCIMENTO',
        'DATA', 'VALIDADE', 'CATEGORIA',
        'ORGAO', 'EXPEDIDOR', 'SSP',
        'DETRAN', 'NACIONAL',
      ];

      const matchedKeywords = docKeywords.filter((kw) => fullText.includes(kw));

      if (matchedKeywords.length < 2) {
        return { valid: false, message: 'Documento nao reconhecido. Envie uma foto clara da sua CNH ou RG.' };
      }

      this.logger.log(`Documento validado - palavras-chave: ${matchedKeywords.join(', ')}`);
      return { valid: true, message: 'Documento reconhecido com sucesso' };
    } catch (error) {
      this.logger.error('Erro na validacao do documento', error);
      return { valid: false, message: 'Erro na validacao do documento. Tente novamente.' };
    }
  }
}
