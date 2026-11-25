import { Card } from '@/components/ui/card';
import { SectionHeader } from '@/components/ui/section';
import { LinkButton } from '@/components/ui/link-button';
import { StatusBadge, type BadgeTone } from '@/components/ui/status-badge';
import { CheckIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import type { OnboardingState, StepState } from '@/lib/onboarding';

const STEP_TITLES = {
  connect: 'Connect your store',
  import: 'Import your store data',
  verify: 'Verify',
} as const;

const stateBadge: Record<StepState, { tone: BadgeTone; label: string }> = {
  done: { tone: 'success', label: 'Done' },
  current: { tone: 'accent', label: 'Next' },
  in_progress: { tone: 'info', label: 'In progress' },
  error: { tone: 'danger', label: 'Needs attention' },
  pending: { tone: 'neutral', label: 'Waiting' },
};

/**
 * First-run checklist (MVP WP5 "Guided commerce onboarding v1"). Rendered from `deriveOnboarding` on every page load,
 * so it resumes wherever the merchant left off. Owners/admins get the action; other members are told who can act.
 * Shown until onboarding is complete; afterwards only the optional next steps remain (never required).
 */
export function OnboardingChecklist({
  workspaceId,
  state,
  canManage,
}: {
  workspaceId: string;
  state: OnboardingState;
  canManage: boolean;
}) {
  const integrationsHref = `/workspace/${workspaceId}/integrations`;

  if (state.complete) {
    if (state.websiteTrackingConnected) return null;
    return (
      <Card className="p-5" aria-label="Optional next steps">
        <SectionHeader title="Optional next steps" />
        <p className="mt-2 text-[13px] text-muted-foreground">
          Your store is set up. You can also add BRAYN&apos;s website tracking to include storefront
          browsing in customer intelligence. It is optional.
        </p>
        {canManage && (
          <div className="mt-3">
            <LinkButton href={integrationsHref} variant="secondary" size="sm">
              Set up website tracking
            </LinkButton>
          </div>
        )}
      </Card>
    );
  }

  const current = state.steps.find((step) => step.state !== 'done' && step.state !== 'pending');
  return (
    <Card className="p-5" aria-label="Get started">
      <SectionHeader
        title="Get started with BRAYN"
        count={`${state.steps.filter((step) => step.state === 'done').length} of ${state.steps.length} done`}
      />
      <p className="mt-1 text-[13px] text-muted-foreground">
        Connect your commerce store so BRAYN can build customer intelligence. Shopify is supported
        today; WooCommerce is coming soon.
      </p>
      <ol className="mt-4 space-y-3">
        {state.steps.map((step, index) => {
          const badge = stateBadge[step.state];
          return (
            <li key={step.key} className="flex items-start gap-3">
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 ring-inset',
                  step.state === 'done'
                    ? 'bg-success/10 text-success ring-success/20'
                    : 'bg-subtle text-foreground/70 ring-border',
                )}
              >
                {step.state === 'done' ? <CheckIcon className="h-3 w-3" /> : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-medium text-foreground">{STEP_TITLES[step.key]}</p>
                  <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                </div>
                <p
                  className={cn(
                    'text-[13px]',
                    step.state === 'error' ? 'text-danger' : 'text-muted-foreground',
                  )}
                >
                  {step.detail}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {current && (
        <div className="mt-4">
          {canManage ? (
            <LinkButton href={integrationsHref} size="sm">
              {current.key === 'connect' && current.state === 'current'
                ? 'Connect Shopify'
                : current.key === 'import' && current.state !== 'in_progress'
                  ? 'Go to import'
                  : 'Open integrations'}
            </LinkButton>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              Ask a workspace owner or admin to complete setup.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
