import { Module } from '@nestjs/common';
import { CustomerService } from './customer.service';

/**
 * Owns normalized commerce data (doc 22 — Commerce data area): customers,
 * products, orders and their line items, keyed to their source provider.
 * See "06. BRAYN Integration & Ingestion" — "After normalization,
 * domain-specific data belongs to its respective domain."
 *
 * Phase 4 part: customer records only, written by Integration's import
 * pipeline. Product/order tables and services land in later Phase 4 parts.
 */
@Module({
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CommerceModule {}
