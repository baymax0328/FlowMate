import { Module } from '@nestjs/common';
import { services } from '../../core/contracts';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';

const searchService = new SearchService();

export function registerSearch(): SearchService {
  services.search = searchService;
  return searchService;
}

@Module({
  controllers: [SearchController],
  providers: [{ provide: SearchService, useValue: searchService }],
  exports: [SearchService],
})
export class SearchModule {}

export { SearchService } from './search.service';
