import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SiteConfig } from './site-config.entity';

const DEFAULTS: Record<string, string> = {
  hero_title: 'Compre local. Venda mais. Tudo num app.',
  hero_subtitle: 'Conectamos clientes a lojas e serviços locais com entrega rápida. Para vendedores, o painel mais simples e poderoso para gerenciar seu negócio digital.',
  contact_whatsapp: '+55 53 8442-4244',
  contact_email: 'contato@bcmtech.com.br',
  app_download_url: '',
  app_download_text: 'Em breve nas lojas',
  show_stats: 'false',
  show_testimonials: 'false',
  platform_description: 'Marketplace local para produtos e serviços. Conectando clientes e vendedores desde 2025.',
};

@Injectable()
export class SiteConfigService implements OnModuleInit {
  constructor(
    @InjectRepository(SiteConfig)
    private repo: Repository<SiteConfig>,
  ) {}

  async onModuleInit() {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      const exists = await this.repo.findOne({ where: { key } });
      if (!exists) {
        await this.repo.save(this.repo.create({ key, value }));
      }
    }
  }

  async getAll(): Promise<SiteConfig[]> {
    return this.repo.find();
  }

  async get(key: string): Promise<SiteConfig | null> {
    return this.repo.findOne({ where: { key } });
  }

  async set(key: string, value: string): Promise<SiteConfig> {
    let config = await this.repo.findOne({ where: { key } });
    if (!config) {
      config = this.repo.create({ key, value });
    } else {
      config.value = value;
    }
    return this.repo.save(config);
  }
}
