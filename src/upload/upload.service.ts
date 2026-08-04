import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { fetchWithTimeout } from '../common/utils/fetch-with-timeout'; // KAN-253

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(private configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get('CLOUDINARY_API_SECRET'),
    });
  }

  async uploadBase64(base64: string, folder = 'delivery'): Promise<string> {
    // Limit base64 payload to ~10MB (base64 is ~33% larger than raw)
    const MAX_BASE64_LENGTH = 14_000_000;
    if (base64.length > MAX_BASE64_LENGTH) {
      throw new Error('Imagem muito grande. Tamanho máximo: 10MB.');
    }

    // Quando a string ja vem como data URI, o mimetype era do CLIENTE e passava
    // sem inspecao nenhuma. `resource_type: 'image'` do Cloudinary ainda aceita
    // SVG, que devolve uma URL servida como imagem e executa script para quem a
    // abrir direto no navegador — alem de virar hospedagem gratuita de conteudo
    // arbitrario na conta paga da plataforma.
    const FORMATOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];
    if (base64.startsWith('data:')) {
      const mime = (base64.slice(5).split(';')[0] || '').toLowerCase();
      if (!FORMATOS_PERMITIDOS.includes(mime)) {
        throw new Error(
          'Formato de imagem nao suportado. Envie JPG, PNG ou WEBP.',
        );
      }
    }

    const dataUri = base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;

    const result = await cloudinary.uploader.upload(dataUri, {
      folder,
      resource_type: 'image',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    });

    this.logger.log(`Imagem enviada: ${result.secure_url}`);
    return result.secure_url;
  }

  private isAllowedUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      const hostname = parsed.hostname.toLowerCase();
      // Block private/internal IPs and metadata endpoints
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname === '[::1]' ||
        hostname === '169.254.169.254' ||
        hostname.startsWith('10.') ||
        hostname.startsWith('192.168.') ||
        hostname.match(/^172\.(1[6-9]|2\d|3[01])\./) ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.local')
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async uploadFromUrl(url: string, folder = 'delivery'): Promise<string> {
    if (!this.isAllowedUrl(url)) {
      throw new Error('URL não permitida. Use apenas URLs públicas (http/https).');
    }

    const result = await cloudinary.uploader.upload(url, {
      folder,
      resource_type: 'image',
    });

    this.logger.log(`Imagem da web salva: ${result.secure_url}`);
    return result.secure_url;
  }

  async searchImages(query: string): Promise<string[]> {
    const apiKey = this.configService.get('SERPAPI_KEY');
    if (!apiKey) {
      this.logger.warn('SERPAPI_KEY nao configurada');
      return [];
    }

    const params = new URLSearchParams({
      q: query,
      engine: 'google_images',
      api_key: apiKey,
      num: '8',
      ijn: '0',
    });

    const response = await fetchWithTimeout(`https://serpapi.com/search.json?${params}`);
    const data = await response.json();

    if (!data.images_results) return [];

    return data.images_results
      .slice(0, 8)
      .map((img: any) => img.thumbnail || img.original)
      .filter(Boolean);
  }
}
