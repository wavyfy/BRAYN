/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, createAutomation } = vi.hoisted(() => ({
  refresh: vi.fn(),
  createAutomation: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ createAutomation }));

import { CreateAutomationForm } from './create-automation-form';

describe('CreateAutomationForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('(1) defaults to the revenue-opportunity trigger, available as an option', () => {
    render(<CreateAutomationForm workspaceId="ws_1" />);

    expect((screen.getByLabelText('Trigger') as HTMLSelectElement).value).toBe('revenue_opportunity.created');
    expect(screen.getByRole('option', { name: 'Revenue opportunity created' })).toBeTruthy();
  });

  it('(2) offers the customer-health trigger as a selectable option', () => {
    render(<CreateAutomationForm workspaceId="ws_1" />);

    expect(screen.getByRole('option', { name: 'Customer health recalculated' })).toBeTruthy();
  });

  it('(3) shows the revenue-opportunity condition fields when that trigger is selected (the default)', () => {
    render(<CreateAutomationForm workspaceId="ws_1" />);

    expect(screen.getByText('Priority')).toBeTruthy();
    expect(screen.getByText('Opportunity type')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'critical' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'win back' })).toBeTruthy();
  });

  it('(4) hides the revenue-opportunity condition fields when the customer-health trigger is selected', () => {
    render(<CreateAutomationForm workspaceId="ws_1" />);

    fireEvent.change(screen.getByLabelText('Trigger'), { target: { value: 'customer_health.recalculated' } });

    expect(screen.queryByText('Priority')).toBeNull();
    expect(screen.queryByText('Opportunity type')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/customer's health score is recalculated/)).toBeTruthy();
  });

  it('(5) submits triggerType: "customer_health.recalculated" and no conditions when that trigger is selected', async () => {
    createAutomation.mockResolvedValueOnce(undefined);
    render(<CreateAutomationForm workspaceId="ws_1" />);

    fireEvent.change(screen.getByLabelText('Trigger'), { target: { value: 'customer_health.recalculated' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reach out on health change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add automation' }));
    await screen.findByRole('button', { name: 'Add automation' });

    expect(createAutomation).toHaveBeenCalledWith('ws_1', 'Reach out on health change', 'customer_health.recalculated', undefined);
  });

  it('(5)(6) submits triggerType: "revenue_opportunity.created" with the selected conditions — existing default behavior unchanged', async () => {
    createAutomation.mockResolvedValueOnce(undefined);
    render(<CreateAutomationForm workspaceId="ws_1" />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Recommend on new opportunity' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'critical' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'win back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add automation' }));
    await screen.findByRole('button', { name: 'Add automation' });

    expect(createAutomation).toHaveBeenCalledWith(
      'ws_1',
      'Recommend on new opportunity',
      'revenue_opportunity.created',
      { priorityIn: ['critical'], typeIn: ['win_back'] },
    );
  });

  it('(7) shows an inline error and re-enables the button when submission fails, regardless of trigger type', async () => {
    createAutomation.mockRejectedValueOnce(new Error('network down'));
    render(<CreateAutomationForm workspaceId="ws_1" />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reach out on health change' } });
    fireEvent.change(screen.getByLabelText('Trigger'), { target: { value: 'customer_health.recalculated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add automation' }));
    await screen.findByText('Could not create this automation. Please try again.');

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add automation' }).hasAttribute('disabled')).toBe(false);
  });

  it('(7) clears the form and refreshes the list after a successful submission', async () => {
    createAutomation.mockResolvedValueOnce(undefined);
    render(<CreateAutomationForm workspaceId="ws_1" />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Recommend on new opportunity' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add automation' }));
    await screen.findByRole('button', { name: 'Add automation' });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Trigger') as HTMLSelectElement).value).toBe('revenue_opportunity.created');
  });
});
