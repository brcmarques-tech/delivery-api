import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { SiteConfigService } from './site-config.service';
import { SiteConfig } from './site-config.entity';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';

@Resolver(() => SiteConfig)
export class SiteConfigResolver {
  constructor(private readonly service: SiteConfigService) {}

  @Query(() => [SiteConfig])
  async getAllSiteConfig(): Promise<SiteConfig[]> {
    return this.service.getAll();
  }

  @Query(() => SiteConfig, { nullable: true })
  async getSiteConfig(@Args('key') key: string): Promise<SiteConfig | null> {
    return this.service.get(key);
  }

  @Mutation(() => SiteConfig)
  @UseGuards(GqlAuthGuard, RolesGuard)
  @Roles(UserRole.SUPERADMIN)
  async setSiteConfig(
    @Args('key') key: string,
    @Args('value') value: string,
  ): Promise<SiteConfig> {
    return this.service.set(key, value);
  }
}
