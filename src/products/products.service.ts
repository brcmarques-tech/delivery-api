import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { PubSub } from 'graphql-subscriptions';
import { firstValueFrom } from 'rxjs';
import { Product } from './entities/product.entity';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { BulkCreateProductsInput, BulkImportResult } from './dto/bulk-create-products.input';
import { BarcodeLookupResult } from './dto/barcode-lookup-result';
import { PUB_SUB } from '../pubsub/pubsub.module';
import { Store } from '../stores/entities/store.entity';
import { PlatformConfigService } from '../config/platform-config.service';
import { VerificationService } from '../stores/verification.service';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Store)
    private storeRepository: Repository<Store>,
    @Inject(PUB_SUB) private pubSub: PubSub,
    private httpService: HttpService,
    private platformConfigService: PlatformConfigService,
    @Inject(forwardRef(() => VerificationService))
    private verificationService: VerificationService,
  ) {}

  // SEGURANCA: o dono da LOJA e do PRODUTO ja eram checados, mas o `categoryId`
  // entrava cru. Um vendedor podia criar/editar um produto da sua loja apontando
  // para uma categoria de OUTRA loja — e a vitrine publica monta o catalogo por
  // categoria (store.categories -> c.products), entao o produto dele aparecia
  // dentro da loja alheia. Injecao de catalogo entre lojas.
  private async assertCategoryBelongsToStore(
    categoryId: string | undefined | null,
    storeId: string,
  ): Promise<void> {
    if (!categoryId) return;
    const rows = await this.productsRepository.manager.query(
      `SELECT 1 FROM categories WHERE id = $1 AND "storeId" = $2 LIMIT 1`,
      [categoryId, storeId],
    );
    if (!rows || rows.length === 0) {
      throw new BadRequestException('Categoria invalida para esta loja.');
    }
  }

  private async checkProductLimit(storeId: string): Promise<void> {
    const store = await this.storeRepository.findOne({
      where: { id: storeId },
      relations: ['owner'],
    });
    if (!store?.owner) return;
    const plan = store.owner.vendorPlan || 'FREE';
    const config = await this.platformConfigService.getPlanConfig(plan);
    if (config.maxProductsPerStore === 0) return; // 0 = ilimitado
    const currentCount = await this.productsRepository.count({
      where: { store: { id: storeId }, isActive: true },
    });
    if (currentCount >= config.maxProductsPerStore) {
      throw new BadRequestException(
        `Limite de produtos atingido (${config.maxProductsPerStore}). Faca upgrade do seu plano para adicionar mais produtos.`,
      );
    }
  }

  async create(input: CreateProductInput): Promise<Product> {
    await this.checkProductLimit(input.storeId);
    const isVariableWeight = input.isVariableWeight ?? false;
    const unit = input.unit ?? (isVariableWeight ? 'kg' : undefined);
    const product = this.productsRepository.create({
      name: input.name,
      description: input.description,
      price: input.price,
      imageUrl: input.imageUrl,
      unit,
      stock: input.stock ?? 0,
      barcode: input.barcode,
      isVariableWeight,
      store: { id: input.storeId } as any,
      category: input.categoryId ? ({ id: input.categoryId } as any) : undefined,
    });
    await this.assertCategoryBelongsToStore(input.categoryId, input.storeId);
    const saved = await this.productsRepository.save(product);
    this.pubSub.publish('productUpdated', { productUpdated: saved });
    this.verificationService.onProductAdded(input.storeId).catch(() => {});
    return saved;
  }

  async findByStore(storeId: string): Promise<Product[]> {
    return this.productsRepository.find({
      where: { store: { id: storeId }, isActive: true },
      // 'store' é @Field(() => Store) NÃO-nulável no schema; sem carregar a
      // relation, selecionar `store { ... }` num product 500a a lista inteira.
      relations: ['category', 'store'],
    }) as Promise<Product[]>;
  }

  async findByStoreAll(storeId: string): Promise<Product[]> {
    return this.productsRepository.find({
      where: { store: { id: storeId } },
      relations: ['category', 'store'],
    }) as Promise<Product[]>;
  }

  async findById(id: string): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: ['store', 'category'],
    });
    if (!product) throw new NotFoundException('Produto nao encontrado');
    return product;
  }

  // Igual ao findById, mas inclui produtos soft-deleted (usado na verificacao
  // de ownership do restore, que por definicao age sobre um produto deletado).
  async findByIdAnyState(id: string): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: ['store'],
      withDeleted: true,
    });
    if (!product) throw new NotFoundException('Produto nao encontrado');
    return product;
  }

  async update(input: UpdateProductInput): Promise<Product> {
    const product = await this.findById(input.id);
    if (input.name !== undefined) product.name = input.name;
    if (input.description !== undefined) product.description = input.description;
    if (input.price !== undefined) product.price = input.price;
    if (input.imageUrl !== undefined) product.imageUrl = input.imageUrl;
    if (input.unit !== undefined) product.unit = input.unit;
    if (input.categoryId !== undefined) {
      await this.assertCategoryBelongsToStore(
        input.categoryId,
        (product as any).store?.id ?? (product as any).storeId,
      );
      product.category = input.categoryId ? ({ id: input.categoryId } as any) : null;
    }
    if (input.stock !== undefined) product.stock = input.stock;
    if (input.barcode !== undefined) product.barcode = input.barcode;
    if (input.isVariableWeight !== undefined) product.isVariableWeight = input.isVariableWeight;
    const saved = await this.productsRepository.save(product);
    this.pubSub.publish('productUpdated', { productUpdated: saved });
    return saved;
  }

  async toggleAvailability(id: string): Promise<Product> {
    const product = await this.findById(id);
    product.isAvailable = !product.isAvailable;
    const saved = await this.productsRepository.save(product);
    this.pubSub.publish('productUpdated', { productUpdated: saved });
    return saved;
  }

  async toggleActive(id: string): Promise<Product> {
    const product = await this.findById(id);
    product.isActive = !product.isActive;
    if (!product.isActive) {
      product.isAvailable = false;
    } else if (product.store?.id) {
      // O limite do plano so era checado no create/bulkCreate — reativar nao
      // contava. FREE com limite 10: cria 10, desativa todos (count 0), cria
      // mais 10, reativa os primeiros -> 20 ativos. Reativar e a mesma coisa
      // que criar do ponto de vista do limite.
      await this.checkProductLimit(product.store.id);
    }
    const saved = await this.productsRepository.save(product);
    this.pubSub.publish('productUpdated', { productUpdated: saved });
    return saved;
  }

  /**
   * KAN-260: era ler-modificar-salvar (le o estoque, subtrai em memoria,
   * salva). Duas chamadas concorrentes liam o MESMO valor, as duas passavam na
   * validacao e a segunda gravava por cima da primeira — vendia mais do que
   * havia (e o `save()` da entity inteira ainda podia sobrescrever colunas que
   * outro processo tivesse alterado no meio, tipo o preco).
   *
   * Agora quem valida e o proprio UPDATE: `WHERE stock >= $1` garante que duas
   * chamadas simultaneas nao passam. Mesmo padrao ja usado na criacao de
   * pedido (orders.service) e nos estornos (payments.service).
   */
  async decrementStock(id: string, quantity: number): Promise<void> {
    const rows = await this.productsRepository.query(
      `UPDATE products
          SET stock = stock - $1,
              "isAvailable" = CASE WHEN stock - $1 <= 0 THEN false ELSE "isAvailable" END
        WHERE id = $2 AND stock >= $1
        RETURNING id`,
      [quantity, id],
    );

    if (!rows.length) {
      // Nao afetou nenhuma linha: ou o produto sumiu, ou o estoque acabou
      // entre a leitura do cliente e este UPDATE.
      const product = await this.findById(id);
      throw new BadRequestException(
        `Estoque insuficiente para "${product.name}". Disponivel: ${product.stock}, solicitado: ${quantity}`,
      );
    }

    const updated = await this.productsRepository.findOne({ where: { id } });
    if (updated) {
      this.pubSub.publish('productUpdated', { productUpdated: updated });
    }
  }

  /**
   * KAN-260: mesma correcao. Aqui o risco era perder devolucoes de estoque —
   * dois cancelamentos simultaneos do mesmo produto liam o mesmo valor e um
   * dos incrementos sumia, deixando o lojista com menos estoque do que tem.
   */
  async restoreStock(id: string, quantity: number): Promise<void> {
    const rows = await this.productsRepository.query(
      `UPDATE products
          SET stock = stock + $1,
              "isAvailable" = CASE WHEN stock + $1 > 0 THEN true ELSE "isAvailable" END
        WHERE id = $2
        RETURNING id`,
      [quantity, id],
    );
    if (!rows.length) return; // produto nao existe mais — mesmo comportamento de antes

    const updated = await this.productsRepository.findOne({ where: { id } });
    if (updated) {
      this.pubSub.publish('productUpdated', { productUpdated: updated });
    }
  }

  async findDeletedByStore(storeId: string): Promise<Product[]> {
    return this.productsRepository
      .createQueryBuilder('product')
      .withDeleted()
      .leftJoinAndSelect('product.category', 'category')
      .where('product.storeId = :storeId', { storeId })
      .andWhere('product.deletedAt IS NOT NULL')
      .orderBy('product.deletedAt', 'DESC')
      .getMany();
  }

  async restore(id: string): Promise<Product> {
    // Mesmo furo do toggleActive: o count do limite ignora soft-deleted, entao
    // restaurar um produto ativo aumenta o total sem passar pela checagem.
    // A checagem vem ANTES do restore — depois seria tarde.
    const deletado = await this.productsRepository.findOne({
      where: { id },
      withDeleted: true,
      relations: ['store'],
    });
    if (!deletado) throw new NotFoundException('Produto nao encontrado');
    if (deletado.isActive && deletado.store?.id) {
      await this.checkProductLimit(deletado.store.id);
    }

    await this.productsRepository.restore(id);
    const product = await this.productsRepository.findOne({ where: { id }, relations: ['store', 'category'] });
    if (!product) throw new NotFoundException('Produto nao encontrado');
    return product;
  }

  async delete(id: string): Promise<boolean> {
    const product = await this.findById(id);
    const storeId = product.store?.id;
    await this.productsRepository.softRemove(product);
    this.pubSub.publish('productDeleted', { productDeleted: { id, storeId } });
    return true;
  }

  async lookupBarcode(barcode: string): Promise<BarcodeLookupResult> {
    const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;
    try {
      const { data } = await firstValueFrom(this.httpService.get(url));
      if (data.status !== 1 || !data.product) {
        return { barcode };
      }
      const p = data.product;
      return {
        barcode,
        name: p.product_name || p.product_name_pt || p.product_name_en,
        description: p.generic_name || p.generic_name_pt,
        imageUrl: p.image_front_url || p.image_url,
        brand: p.brands,
        quantity: p.quantity,
      };
    } catch {
      return { barcode };
    }
  }

  async searchPublic(query: string, limit = 20): Promise<Product[]> {
    if (!query.trim()) return [];

    const terms = query.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);

    const qb = this.productsRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.store', 'store')
      .leftJoinAndSelect('product.category', 'category')
      .where('store.isActive = :active', { active: true })
      .andWhere('product.isAvailable = :available', { available: true })
      .andWhere('product.isActive = :isActive', { isActive: true });

    // Busca insensivel a acento (auditoria): LOWER puro nao casa "pao" com
    // "pão" — unaccent() nos dois lados do LIKE resolve para qualquer grafia.
    if (terms.length === 1) {
      qb.andWhere(
        '(unaccent(LOWER(product.name)) LIKE unaccent(:q) OR unaccent(LOWER(product.description)) LIKE unaccent(:q) OR unaccent(LOWER(category.name)) LIKE unaccent(:q))',
        { q: `%${terms[0]}%` },
      );
    } else {
      const conditions = terms.map((t, i) =>
        `(unaccent(LOWER(product.name)) LIKE unaccent(:t${i}) OR unaccent(LOWER(product.description)) LIKE unaccent(:t${i}) OR unaccent(LOWER(category.name)) LIKE unaccent(:t${i}))`
      ).join(' OR ');
      const params: Record<string, string> = {};
      terms.forEach((t, i) => { params[`t${i}`] = `%${t}%`; });
      qb.andWhere(`(${conditions})`, params);
    }

    // Desempate por id: nomes repetidos deixavam a ordem ao acaso do plano de
    // execucao — resultados "pulavam" entre chamadas iguais.
    return qb.orderBy('product.name').addOrderBy('product.id').limit(limit).getMany();
  }

  async searchCatalog(query: string, limit = 20): Promise<Product[]> {
    if (!query.trim()) return [];

    // Get unique product IDs (one per name), preferring oldest entry (catalog)
    // unaccent: "acucar" precisa achar "açúcar" (auditoria, busca com acento)
    const uniqueIds = await this.productsRepository.query(
      `SELECT DISTINCT ON (LOWER(name)) id
       FROM products
       WHERE unaccent(LOWER(name)) LIKE unaccent($1) OR barcode = $2
       ORDER BY LOWER(name), "createdAt" ASC
       LIMIT $3`,
      [`%${query.toLowerCase()}%`, query.trim(), limit],
    );

    if (uniqueIds.length === 0) return [];

    const ids = uniqueIds.map((r: any) => r.id);

    return this.productsRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.store', 'store')
      .leftJoinAndSelect('product.category', 'category')
      .whereInIds(ids)
      .orderBy('product.name')
      .getMany();
  }

  async bulkCreate(input: BulkCreateProductsInput): Promise<BulkImportResult> {
    // Check limit before starting bulk import
    const store = await this.storeRepository.findOne({
      where: { id: input.storeId },
      relations: ['owner'],
    });
    const plan = store?.owner?.vendorPlan || 'FREE';
    const config = await this.platformConfigService.getPlanConfig(plan);
    const currentCount = await this.productsRepository.count({
      where: { store: { id: input.storeId }, isActive: true },
    });
    const maxAllowed = config.maxProductsPerStore === 0 ? Infinity : config.maxProductsPerStore;
    const slotsLeft = maxAllowed - currentCount;

    if (slotsLeft <= 0 && config.maxProductsPerStore > 0) {
      return {
        created: 0,
        errors: [`Limite de produtos atingido (${config.maxProductsPerStore}). Faca upgrade do seu plano.`],
      };
    }

    let created = 0;
    const errors: string[] = [];

    for (let i = 0; i < input.products.length; i++) {
      if (created >= slotsLeft) {
        errors.push(`Linha ${i + 1} (${input.products[i].name}): Limite de produtos atingido (${config.maxProductsPerStore})`);
        continue;
      }
      const item = input.products[i];
      try {
        // A importacao em massa nao chamava esta checagem — a mesma que o
        // create/update fazem. Um lojista importava produto apontando para a
        // categoria de OUTRA loja e, como a vitrine monta o catalogo por
        // categoria (categories.service.ts findByStore), o produto dele passava
        // a aparecer dentro da loja alheia, com o preco que ele quisesse.
        await this.assertCategoryBelongsToStore(item.categoryId, input.storeId);

        const itemIsVariableWeight = item.isVariableWeight ?? false;
        const itemUnit = item.unit ?? (itemIsVariableWeight ? 'kg' : undefined);
        const product = this.productsRepository.create({
          name: item.name,
          description: item.description,
          price: item.price,
          imageUrl: item.imageUrl,
          unit: itemUnit,
          stock: item.stock ?? 0,
          barcode: item.barcode,
          isVariableWeight: itemIsVariableWeight,
          store: { id: input.storeId } as any,
          category: item.categoryId ? ({ id: item.categoryId } as any) : undefined,
        });
        await this.productsRepository.save(product);
        created++;
      } catch (err) {
        errors.push(`Linha ${i + 1} (${item.name}): ${err.message}`);
      }
    }

    return { created, errors };
  }
}
