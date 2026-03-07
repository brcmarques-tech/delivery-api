import { Resolver, Mutation, Args } from '@nestjs/graphql';
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
}
