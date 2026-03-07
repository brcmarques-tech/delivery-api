import { Resolver, Mutation, Query, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { UploadService } from './upload.service';

@Resolver()
export class UploadResolver {
  constructor(private uploadService: UploadService) {}

  @Mutation(() => String)
  @UseGuards(GqlAuthGuard)
  async uploadImage(
    @Args('base64') base64: string,
    @Args('folder', { nullable: true }) folder?: string,
  ): Promise<string> {
    return this.uploadService.uploadBase64(base64, folder || 'delivery');
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
    return this.uploadService.uploadFromUrl(url, folder || 'products');
  }
}
