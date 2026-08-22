import { Resolver, Mutation, Query, Args, ObjectType, Field } from '@nestjs/graphql';
import { UseGuards, BadRequestException } from '@nestjs/common';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { UploadService } from './upload.service';
import { VisionService } from './vision.service';

@ObjectType()
class PhotoValidation {
  @Field() valid: boolean;
  @Field() message: string;
  // KAN-230: sinaliza que a validacao automatica NAO rodou (Vision
  // indisponivel/sem credencial). Antes esse caso retornava apenas
  // `valid: true`, indistinguivel de uma aprovacao real — o KYC caia em modo
  // aberto silenciosamente. Com a flag, a aprovacao manual do SUPERADMIN sabe
  // que precisa olhar com mais atencao.
  @Field({ defaultValue: false }) requiresManualReview: boolean;
}

// SEGURANCA: `folder` ia cru para o Cloudinary. Qualquer usuario autenticado
// (inclusive CUSTOMER) podia despejar arquivos em qualquer pasta — inclusive
// `identity` (documentos) — ou inventar caminhos, poluindo o namespace e
// gerando custo de armazenamento. Sem sobrescrita de arquivo (o Cloudinary gera
// public_id aleatorio), mas o abuso de espaco/pasta era livre.
// Levantadas do codigo real dos clientes (app, painel do vendedor, superadmin).
// ATENCAO: adicionar aqui ao criar um novo tipo de upload — uma pasta ausente
// faz a mutation recusar e o fluxo quebra (foi o que quase aconteceu com
// profile-photos/identity-photos no cadastro de entregador).
const PASTAS_PERMITIDAS = new Set([
  'delivery',
  'products',
  'stores',
  'categories',
  'services',
  'promotions',
  'avatars',
  'profile-photos',
  'identity-photos',
  'identity',
]);

function pastaValida(folder: string | undefined, padrao: string): string {
  const f = (folder || padrao).trim();
  if (!PASTAS_PERMITIDAS.has(f)) {
    throw new BadRequestException('Pasta de upload invalida.');
  }
  return f;
}

@Resolver()
export class UploadResolver {
  constructor(
    private uploadService: UploadService,
    private visionService: VisionService,
  ) {}

  @Mutation(() => String)
  @UseGuards(GqlAuthGuard)
  async uploadImage(
    @Args('base64') base64: string,
    @Args('folder', { nullable: true }) folder?: string,
  ): Promise<string> {
    return this.uploadService.uploadBase64(base64, pastaValida(folder, 'delivery'));
  }

  @Query(() => [String])
  @UseGuards(GqlAuthGuard)
  async searchProductImages(
    @Args('query') query: string,
  ): Promise<string[]> {
    return this.uploadService.searchImages(query);
  }

  @Mutation(() => String)
  @UseGuards(GqlAuthGuard)
  async uploadFromUrl(
    @Args('url') url: string,
    @Args('folder', { nullable: true }) folder?: string,
  ): Promise<string> {
    return this.uploadService.uploadFromUrl(url, pastaValida(folder, 'products'));
  }

  @Mutation(() => PhotoValidation)
  @UseGuards(GqlAuthGuard)
  async validateFacePhoto(
    @Args('imageUrl') imageUrl: string,
  ): Promise<PhotoValidation> {
    const result = await this.visionService.validateFacePhoto(imageUrl);
    // KAN-230: normaliza a flag para o contrato nao-nulo do GraphQL.
    return { ...result, requiresManualReview: result.requiresManualReview ?? false };
  }

  @Mutation(() => PhotoValidation)
  @UseGuards(GqlAuthGuard)
  async validateDocumentPhoto(
    @Args('imageUrl') imageUrl: string,
  ): Promise<PhotoValidation> {
    const result = await this.visionService.validateDocumentPhoto(imageUrl);
    // KAN-230: normaliza a flag para o contrato nao-nulo do GraphQL.
    return { ...result, requiresManualReview: result.requiresManualReview ?? false };
  }
}
