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
    } else {
      this.logger.warn(
        'GOOGLE_VISION_CREDENTIALS nao configurado - validacao de fotos desabilitada',
      );
    }
  }

  async validateFacePhoto(imageUrl: string): Promise<{ valid: boolean; message: string }> {
    if (!this.client) {
      this.logger.warn('Vision nao configurado, aceitando foto sem validacao');
      return { valid: true, message: 'Validacao desabilitada' };
    }

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
      return { valid: true, message: 'Erro na validacao, foto aceita' };
    }
  }

  async validateDocumentPhoto(imageUrl: string): Promise<{ valid: boolean; message: string }> {
    if (!this.client) {
      this.logger.warn('Vision nao configurado, aceitando foto sem validacao');
      return { valid: true, message: 'Validacao desabilitada' };
    }

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
      return { valid: true, message: 'Erro na validacao, foto aceita' };
    }
  }
}
