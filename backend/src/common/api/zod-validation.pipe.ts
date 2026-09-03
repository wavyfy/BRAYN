import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ValidationError } from '../errors/app-error';

/**
 * Validates a request value (body/query/params) against a Zod schema —
 * Zod is the locked runtime validation library (doc 29 §24), not Nest's
 * default class-validator. On failure, throws Step 2's ValidationError so
 * the response goes through the same canonical error envelope as every
 * other error.
 *
 * Usage: @Body(new ZodValidationPipe(someSchema)) body: z.infer<typeof someSchema>
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ValidationError(message);
    }

    return result.data;
  }
}
