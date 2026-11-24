/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { deriveOnboarding } from '@/lib/onboarding';
import { OnboardingChecklist } from './onboarding-checklist';

afterEach(cleanup);

const succeeded = {
  status: 'succeeded' as const,
  recordsImported: 42,
  recordsFailed: 0,
  error: null,
};

describe('OnboardingChecklist', () => {
  it('new workspace: owner sees the checklist with a Connect Shopify action and WooCommerce as coming soon', () => {
    render(<OnboardingChecklist workspaceId="ws_1" state={deriveOnboarding([], null)} canManage />);

    expect(screen.getByText('Get started with BRAYN')).toBeTruthy();
    expect(screen.getByText('0 of 3 done')).toBeTruthy();
    expect(screen.getByText(/WooCommerce is coming soon/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect Shopify' }).getAttribute('href')).toBe(
      '/workspace/ws_1/integrations',
    );
  });

  it('members without manage rights get no action, only who can act', () => {
    render(
      <OnboardingChecklist
        workspaceId="ws_1"
        state={deriveOnboarding([], null)}
        canManage={false}
      />,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/Ask a workspace owner or admin/)).toBeTruthy();
  });

  it('a failed import shows the error detail and points to the retry', () => {
    const state = deriveOnboarding([{ provider: 'shopify', status: 'connected' }], {
      status: 'failed',
      recordsImported: 3,
      recordsFailed: 2,
      error: 'x',
    });
    render(<OnboardingChecklist workspaceId="ws_1" state={state} canManage />);

    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(
      screen.getByText(/failed\. 2 records failed\. Retry it from Integrations\./),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to import' })).toBeTruthy();
  });

  it('an import in progress offers no duplicate start action', () => {
    const state = deriveOnboarding([{ provider: 'shopify', status: 'connected' }], {
      status: 'running',
      recordsImported: 5,
      recordsFailed: 0,
      error: null,
    });
    render(<OnboardingChecklist workspaceId="ws_1" state={state} canManage />);

    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Go to import' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open integrations' })).toBeTruthy();
  });

  it('complete: the checklist is replaced by optional (never required) next steps; nothing at all once tracking is set up', () => {
    const { container, rerender } = render(
      <OnboardingChecklist
        workspaceId="ws_1"
        state={deriveOnboarding([{ provider: 'shopify', status: 'connected' }], succeeded)}
        canManage
      />,
    );
    expect(screen.queryByText('Get started with BRAYN')).toBeNull();
    expect(screen.getByText('Optional next steps')).toBeTruthy();
    expect(screen.getByText(/It is optional/)).toBeTruthy();

    rerender(
      <OnboardingChecklist
        workspaceId="ws_1"
        state={deriveOnboarding(
          [
            { provider: 'shopify', status: 'connected' },
            { provider: 'website_tracking', status: 'connected' },
          ],
          succeeded,
        )}
        canManage
      />,
    );
    expect(container.textContent).toBe('');
  });
});

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
