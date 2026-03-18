import { Module, Global } from '@nestjs/common';
import { UploadService } from './upload.service';
import { UploadResolver } from './upload.resolver';
import { VisionService } from './vision.service';

@Global()
@Module({
  providers: [UploadService, UploadResolver, VisionService],
  exports: [UploadService, VisionService],
})
export class UploadModule {}
