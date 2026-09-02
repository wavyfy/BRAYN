import { Module } from '@nestjs/common';
import { CustomerService } from './customer.service';
import { ProductService } from './product.service';
import { OrderService } from './order.service';
import { CollectionService } from './collection.service';

/**
 * Owns normalized commerce data (doc 22 — Commerce data area): customers,
 * products, orders and their line items, keyed to their source provider.
 * See "06. BRAYN Integration & Ingestion" — "After normalization,
 * domain-specific data belongs to its respective domain."
 *
 * Phase 4 parts: customer, product/variant, and order/line-item records,
 * all written by Integration's import pipeline.
 */
@Module({
  providers: [CustomerService, ProductService, OrderService, CollectionService],
  exports: [CustomerService, ProductService, OrderService, CollectionService],
})
export class CommerceModule {}
