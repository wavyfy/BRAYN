import { Module } from '@nestjs/common';
import { CustomerService } from './customer.service';
import { ProductService } from './product.service';

/**
 * Owns normalized commerce data (doc 22 — Commerce data area): customers,
 * products, orders and their line items, keyed to their source provider.
 * See "06. BRAYN Integration & Ingestion" — "After normalization,
 * domain-specific data belongs to its respective domain."
 *
 * Phase 4 parts: customer and product/variant records, written by
 * Integration's import pipeline. Order tables/services land in a later
 * Phase 4 part.
 */
@Module({
  providers: [CustomerService, ProductService],
  exports: [CustomerService, ProductService],
})
export class CommerceModule {}
