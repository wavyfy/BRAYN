import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, ne } from 'drizzle-orm';
import { ValidationError } from '../../../../common/errors/app-error';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import type { Env } from '../../../../config/env.schema';
import { DatabaseService } from '../../../../database/database.service';
import { integrations } from '../../../../database/schema/integrations';
import { IntegrationService } from '../../integration.service';
import {
  ShopifyAdapter,
  shopifyManagedWebhookSubscriptions,
  shopifyTopicEnum,
  type ShopifyWebhookSubscription,
} from './shopify.adapter';

/** One managed topic's address change: header-style topic, the uri it is served at now, the uri it should move to. */
export interface ManagedTopicMove {
  topic: string;
  fromUri: string;
  toUri: string;
}

export type WebhookMigrationAction =
  | { kind: 'keep'; topic: string; subscriptionId: string }
  | { kind: 'update'; topic: string; subscription: ShopifyWebhookSubscription; toUri: string }
  | { kind: 'create'; topic: string; toUri: string }
  | { kind: 'delete'; topic: string; subscriptionId: string; uri: string };

/**
 * Pure plan for moving BRAYN's managed subscriptions from one backend address to another, given what the shop has.
 * Per managed topic it leaves exactly one subscription at `toUri`:
 * - one already there → keep it; extra copies at `toUri` and any left at `fromUri` are deleted;
 * - none there but one at `fromUri` → that one is updated in place (same id, same configuration); extras deleted;
 * - neither → create one at `toUri`.
 * Subscriptions at any other uri (not this backend pair's route for this workspace) are never touched. Running the
 * plan again after it succeeded yields only `keep`; swapping from/to plans the rollback onto the same ids.
 */
export function planWebhookSubscriptionMigration(
  listed: ShopifyWebhookSubscription[],
  moves: ManagedTopicMove[],
): WebhookMigrationAction[] {
  const actions: WebhookMigrationAction[] = [];
  for (const move of moves) {
    const topicEnum = shopifyTopicEnum(move.topic);
    const atTarget = listed.filter((s) => s.topic === topicEnum && s.uri === move.toUri);
    const atSource = listed.filter((s) => s.topic === topicEnum && s.uri === move.fromUri);
    const deletions = (subs: ShopifyWebhookSubscription[]) =>
      subs.map((s): WebhookMigrationAction => ({
        kind: 'delete',
        topic: move.topic,
        subscriptionId: s.id,
        uri: s.uri,
      }));

    if (atTarget.length > 0) {
      actions.push({ kind: 'keep', topic: move.topic, subscriptionId: atTarget[0].id });
      actions.push(...deletions([...atTarget.slice(1), ...atSource]));
    } else if (atSource.length > 0) {
      actions.push({
        kind: 'update',
        topic: move.topic,
        subscription: atSource[0],
        toUri: move.toUri,
      });
      actions.push(...deletions(atSource.slice(1)));
    } else {
      actions.push({ kind: 'create', topic: move.topic, toUri: move.toUri });
    }
  }
  return actions;
}

export interface WebhookMigrationActionResult {
  topic: string;
  kind: WebhookMigrationAction['kind'];
  subscriptionId?: string;
  status: 'planned' | 'done' | 'failed' | 'skipped';
  error?: string;
}

export interface WorkspaceWebhookMigrationResult {
  workspaceId: string;
  actions: WebhookMigrationActionResult[];
  /** After applying: every managed topic has exactly one subscription at the target and none at the source. */
  verified?: boolean;
  error?: string;
}

export interface WebhookMigrationReport {
  fromBackendUrl: string;
  toBackendUrl: string;
  applied: boolean;
  ok: boolean;
  workspaces: WorkspaceWebhookMigrationResult[];
}

/**
 * Explicit, operator-triggered move of Shopify per-shop webhook subscriptions from another BRAYN backend address to
 * THIS backend's BACKEND_URL (stage 12 infrastructure migration). Never runs on startup or on connect, and can only
 * pull subscriptions to the instance executing it — so two backends running side by side can't move them back and
 * forth, and rollback is the same call made on the other backend. Dry run unless `apply` is set.
 *
 * Shopify app-level configuration (OAuth redirect URLs, compliance webhooks in shopify.app.toml) is deliberately not
 * handled here.
 */
@Injectable()
export class ShopifyWebhookMigrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly integrationService: IntegrationService,
    private readonly shopifyAdapter: ShopifyAdapter,
    private readonly config: ConfigService<Env, true>,
    private readonly logger: StructuredLoggerService,
  ) {}

  async migrate(options: {
    fromBackendUrl: string;
    apply: boolean;
    workspaceId?: string;
  }): Promise<WebhookMigrationReport> {
    const toBackendUrl = this.config.get('BACKEND_URL', { infer: true });
    const fromBackendUrl = options.fromBackendUrl.replace(/\/+$/, '');
    if (new URL(fromBackendUrl).origin === new URL(toBackendUrl).origin) {
      throw new ValidationError('fromBackendUrl is this backend; nothing to migrate.');
    }

    const rows = await this.database.client
      .select({ workspaceId: integrations.workspaceId })
      .from(integrations)
      .where(
        and(
          eq(integrations.provider, 'shopify'),
          ne(integrations.status, 'disconnected'),
          options.workspaceId ? eq(integrations.workspaceId, options.workspaceId) : undefined,
        ),
      );

    const workspaces: WorkspaceWebhookMigrationResult[] = [];
    for (const { workspaceId } of rows) {
      // One store's failure never stops or affects another's.
      workspaces.push(
        await this.migrateWorkspace(workspaceId, fromBackendUrl, toBackendUrl, options.apply).catch(
          (error: unknown) => ({
            workspaceId,
            actions: [],
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
        ),
      );
    }

    const ok = workspaces.every(
      (w) =>
        !w.error &&
        w.actions.every((a) => a.status !== 'failed') &&
        (!options.apply || w.verified === true),
    );
    const report: WebhookMigrationReport = {
      fromBackendUrl,
      toBackendUrl,
      applied: options.apply,
      ok,
      workspaces,
    };
    this.logger.event(
      ok ? 'log' : 'error',
      'Shopify webhook subscription migration',
      'ShopifyWebhookMigration',
      {
        fromBackendUrl,
        toBackendUrl,
        applied: options.apply,
        ok,
        workspaces: workspaces.map((w) => ({
          workspaceId: w.workspaceId,
          verified: w.verified,
          error: w.error,
          actions: w.actions.map((a) => `${a.topic}:${a.kind}:${a.status}`),
        })),
      },
    );
    return report;
  }

  private async migrateWorkspace(
    workspaceId: string,
    fromBackendUrl: string,
    toBackendUrl: string,
    apply: boolean,
  ): Promise<WorkspaceWebhookMigrationResult> {
    const credentials = await this.integrationService.getCredentials(workspaceId, 'shopify');
    if (!credentials) {
      return {
        workspaceId,
        actions: [],
        error: 'No Shopify credentials stored for this workspace.',
      };
    }

    const from = shopifyManagedWebhookSubscriptions(fromBackendUrl, workspaceId);
    const to = shopifyManagedWebhookSubscriptions(toBackendUrl, workspaceId);
    const moves = from.map((f, i) => ({ topic: f.topic, fromUri: f.uri, toUri: to[i].uri }));
    const topicEnums = [...new Set(moves.map((m) => shopifyTopicEnum(m.topic)))];

    const plan = planWebhookSubscriptionMigration(
      await this.shopifyAdapter.listWebhookSubscriptions(credentials, topicEnums),
      moves,
    );
    if (!apply) {
      return {
        workspaceId,
        actions: plan.map((action) => ({ ...describe(action), status: 'planned' })),
      };
    }

    // Destinations first (update/create), deletions last: a topic is never left without a subscription because a
    // later step failed. A topic whose destination step failed keeps its source subscriptions.
    const failedTopics = new Set<string>();
    const results: WebhookMigrationActionResult[] = [];
    const ordered = [
      ...plan.filter((a) => a.kind !== 'delete'),
      ...plan.filter((a) => a.kind === 'delete'),
    ];
    for (const action of ordered) {
      if (action.kind === 'delete' && failedTopics.has(action.topic)) {
        results.push({
          ...describe(action),
          status: 'skipped',
          error: 'Destination for this topic failed; source kept.',
        });
        continue;
      }
      try {
        if (action.kind === 'update') {
          await this.shopifyAdapter.updateWebhookSubscriptionUri(
            credentials,
            action.subscription,
            action.toUri,
          );
        } else if (action.kind === 'create') {
          const refusal = await this.shopifyAdapter.createWebhookSubscription(
            credentials,
            shopifyTopicEnum(action.topic),
            action.toUri,
          );
          if (refusal) throw new Error(`Shopify refused the webhook subscription: ${refusal}`);
        } else if (action.kind === 'delete') {
          await this.shopifyAdapter.deleteWebhookSubscription(credentials, action.subscriptionId);
        }
        results.push({ ...describe(action), status: 'done' });
      } catch (error) {
        failedTopics.add(action.topic);
        results.push({
          ...describe(action),
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const after = await this.shopifyAdapter.listWebhookSubscriptions(credentials, topicEnums);
    const verified = moves.every(
      (m) =>
        after.filter((s) => s.topic === shopifyTopicEnum(m.topic) && s.uri === m.toUri).length ===
          1 && !after.some((s) => s.topic === shopifyTopicEnum(m.topic) && s.uri === m.fromUri),
    );
    return { workspaceId, actions: results, verified };
  }
}

function describe(action: WebhookMigrationAction): Omit<WebhookMigrationActionResult, 'status'> {
  switch (action.kind) {
    case 'keep':
      return { topic: action.topic, kind: action.kind, subscriptionId: action.subscriptionId };
    case 'update':
      return { topic: action.topic, kind: action.kind, subscriptionId: action.subscription.id };
    case 'delete':
      return { topic: action.topic, kind: action.kind, subscriptionId: action.subscriptionId };
    case 'create':
      return { topic: action.topic, kind: action.kind };
  }
}
