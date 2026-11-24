/**
 * Guided commerce onboarding v1 (MVP WP5, Nov 24, 2026). Every step is derived from data the API already returns —
 * integrations and the latest import run — so the checklist is resumable after a refresh or an interrupted Shopify
 * OAuth (nothing about progress is stored client-side or in new tables).
 *
 * Launch readiness lives here, in one place: Shopify is the supported commerce platform for the public beta;
 * WooCommerce is "coming soon" (its backend stays; the UI offers no new connection until real-store acceptance is
 * approved). Adding a platform to SUPPORTED_COMMERCE_PLATFORMS is the only change needed when one becomes ready.
 */
export const SUPPORTED_COMMERCE_PLATFORMS = ['shopify'] as const;
export const COMING_SOON_COMMERCE_PLATFORMS = ['woocommerce'] as const;

export type OnboardingIntegration = {
  provider: string;
  status: string;
  lastSyncError?: string | null;
};
export type OnboardingImportRun = {
  status: 'running' | 'succeeded' | 'failed' | 'partial';
  recordsImported: number;
  recordsFailed: number;
  error: string | null;
} | null;

export type StepState = 'done' | 'current' | 'in_progress' | 'error' | 'pending';
export type OnboardingStep = {
  key: 'connect' | 'import' | 'verify';
  state: StepState;
  detail: string;
};

export interface OnboardingState {
  /** The supported commerce platform this workspace is onboarding with, if connected. */
  commerceProvider: (typeof SUPPORTED_COMMERCE_PLATFORMS)[number] | null;
  steps: OnboardingStep[];
  /** Connected to a supported platform and its first import succeeded — commerce intelligence can start. */
  complete: boolean;
  websiteTrackingConnected: boolean;
}

const isLive = (integration: OnboardingIntegration | undefined) =>
  Boolean(integration && integration.status !== 'disconnected');

/** `commerceImport`: the latest import run, `null` when none ran yet, `undefined` when its status could not be loaded. */
export function deriveOnboarding(
  integrations: OnboardingIntegration[],
  commerceImport: OnboardingImportRun | undefined,
): OnboardingState {
  const commerce = integrations.find(
    (integration) =>
      (SUPPORTED_COMMERCE_PLATFORMS as readonly string[]).includes(integration.provider) &&
      isLive(integration),
  );
  const websiteTrackingConnected = isLive(
    integrations.find((integration) => integration.provider === 'website_tracking'),
  );

  if (!commerce) {
    return {
      commerceProvider: null,
      complete: false,
      websiteTrackingConnected,
      steps: [
        { key: 'connect', state: 'current', detail: 'Connect your Shopify store.' },
        { key: 'import', state: 'pending', detail: 'Starts after your store is connected.' },
        { key: 'verify', state: 'pending', detail: 'Confirms your store data arrived.' },
      ],
    };
  }

  const connectionHealthy = commerce.status === 'connected' || commerce.status === 'syncing';
  const connect: OnboardingStep = connectionHealthy
    ? { key: 'connect', state: 'done', detail: 'Store connected.' }
    : {
        key: 'connect',
        state: 'error',
        detail: commerce.lastSyncError ?? 'The connection needs attention — open Integrations.',
      };

  let importStep: OnboardingStep;
  if (commerceImport === undefined) {
    importStep = {
      key: 'import',
      state: 'error',
      detail: "Couldn't load the import status — open Integrations to check it.",
    };
  } else if (!commerceImport) {
    importStep = {
      key: 'import',
      state: 'current',
      detail: 'Run the first import of customers, orders and products.',
    };
  } else if (commerceImport.status === 'running') {
    importStep = {
      key: 'import',
      state: 'in_progress',
      detail: `Importing… ${commerceImport.recordsImported} records so far.`,
    };
  } else if (commerceImport.status === 'succeeded') {
    importStep = {
      key: 'import',
      state: 'done',
      detail: `${commerceImport.recordsImported} records imported.`,
    };
  } else {
    const failed =
      commerceImport.recordsFailed > 0 ? ` ${commerceImport.recordsFailed} records failed.` : '';
    importStep = {
      key: 'import',
      state: 'error',
      detail: `The last import ${commerceImport.status === 'partial' ? 'finished partially' : 'failed'}.${failed} Retry it from Integrations.`,
    };
  }

  const complete = connectionHealthy && commerceImport?.status === 'succeeded';
  const verify: OnboardingStep = complete
    ? { key: 'verify', state: 'done', detail: 'Your store data is in BRAYN.' }
    : {
        key: 'verify',
        state: 'pending',
        detail: 'Completes when the store is connected and the first import succeeds.',
      };

  return {
    commerceProvider: commerce.provider as OnboardingState['commerceProvider'],
    complete,
    websiteTrackingConnected,
    steps: [connect, importStep, verify],
  };
}
