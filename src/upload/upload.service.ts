import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';

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
    const dataUri = base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;

    const result = await cloudinary.uploader.upload(dataUri, {
      folder,
      resource_type: 'image',
    });

    this.logger.log(`Imagem enviada: ${result.secure_url}`);
    return result.secure_url;
  }

  async uploadFromUrl(url: string, folder = 'delivery'): Promise<string> {
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

    const response = await fetch(`https://serpapi.com/search.json?${params}`);
    const data = await response.json();

    if (!data.images_results) return [];

    return data.images_results
      .slice(0, 8)
      .map((img: any) => img.thumbnail || img.original)
      .filter(Boolean);
  }
}
