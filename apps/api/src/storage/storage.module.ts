import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';
import { FilesController } from './files.controller.js';

@Global()
@Module({ controllers: [FilesController], providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
