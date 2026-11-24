import { describe, expect, it } from 'vitest';
import { deriveOnboarding, type OnboardingImportRun } from './onboarding';

const run = (
  status: NonNullable<OnboardingImportRun>['status'],
  recordsImported = 10,
  recordsFailed = 0,
): OnboardingImportRun => ({
  status,
  recordsImported,
  recordsFailed,
  error: null,
});
const states = (result: ReturnType<typeof deriveOnboarding>) =>
  result.steps.map((step) => `${step.key}:${step.state}`);

describe('deriveOnboarding', () => {
  it('new workspace: connect is the current step, nothing complete', () => {
    const result = deriveOnboarding([], null);
    expect(states(result)).toEqual(['connect:current', 'import:pending', 'verify:pending']);
    expect(result).toMatchObject({
      complete: false,
      commerceProvider: null,
      websiteTrackingConnected: false,
    });
  });

  it('a disconnected Shopify row (e.g. interrupted or reverted OAuth) resumes at connect', () => {
    expect(
      states(deriveOnboarding([{ provider: 'shopify', status: 'disconnected' }], null)),
    ).toEqual(['connect:current', 'import:pending', 'verify:pending']);
  });

  it('connected without an import: import is current', () => {
    expect(states(deriveOnboarding([{ provider: 'shopify', status: 'connected' }], null))).toEqual([
      'connect:done',
      'import:current',
      'verify:pending',
    ]);
  });

  it('import running → in progress; succeeded → complete', () => {
    expect(
      states(deriveOnboarding([{ provider: 'shopify', status: 'connected' }], run('running', 3))),
    ).toEqual(['connect:done', 'import:in_progress', 'verify:pending']);
    const done = deriveOnboarding(
      [{ provider: 'shopify', status: 'connected' }],
      run('succeeded', 42),
    );
    expect(states(done)).toEqual(['connect:done', 'import:done', 'verify:done']);
    expect(done).toMatchObject({ complete: true, commerceProvider: 'shopify' });
    expect(done.steps[1]!.detail).toContain('42');
  });

  it('failed or partial import is an error with retry guidance, never complete', () => {
    for (const status of ['failed', 'partial'] as const) {
      const result = deriveOnboarding(
        [{ provider: 'shopify', status: 'connected' }],
        run(status, 5, 2),
      );
      expect(states(result)).toEqual(['connect:done', 'import:error', 'verify:pending']);
      expect(result.complete).toBe(false);
      expect(result.steps[1]!.detail).toMatch(/Retry/);
    }
  });

  it('a successful import with zero records still completes onboarding (an empty store is a valid store)', () => {
    const result = deriveOnboarding(
      [{ provider: 'shopify', status: 'connected' }],
      run('succeeded', 0),
    );
    expect(result.complete).toBe(true);
    expect(result.steps[1]!.detail).toBe('0 records imported.');
  });

  it('a connection in error state blocks completion even after a successful import; no provider error text is shown', () => {
    const result = deriveOnboarding([{ provider: 'shopify', status: 'error' }], run('succeeded'));
    expect(states(result)).toEqual(['connect:error', 'import:done', 'verify:pending']);
    expect(result.steps[0]!.detail).toBe('The connection needs attention — open Integrations.');
    expect(result.complete).toBe(false);
  });

  it('WooCommerce is not a supported platform yet: an existing WooCommerce connection does not complete onboarding', () => {
    const result = deriveOnboarding(
      [{ provider: 'woocommerce', status: 'connected' }],
      run('succeeded'),
    );
    expect(result).toMatchObject({ complete: false, commerceProvider: null });
  });

  it('an import status that could not be loaded is shown as needing attention, not as "not started"', () => {
    const result = deriveOnboarding([{ provider: 'shopify', status: 'connected' }], undefined);
    expect(states(result)).toEqual(['connect:done', 'import:error', 'verify:pending']);
    expect(result.steps[1]!.detail).toMatch(/Couldn't load/);
  });

  it('website tracking is reported as optional context only', () => {
    const result = deriveOnboarding(
      [
        { provider: 'shopify', status: 'connected' },
        { provider: 'website_tracking', status: 'connected' },
      ],
      run('succeeded'),
    );
    expect(result).toMatchObject({ complete: true, websiteTrackingConnected: true });
  });
});
