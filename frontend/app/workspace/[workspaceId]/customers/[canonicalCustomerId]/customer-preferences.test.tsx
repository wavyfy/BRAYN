/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, createCustomerPreference, updateCustomerPreference, archiveCustomerPreference } = vi.hoisted(() => ({
  refresh: vi.fn(),
  createCustomerPreference: vi.fn(),
  updateCustomerPreference: vi.fn(),
  archiveCustomerPreference: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ createCustomerPreference, updateCustomerPreference, archiveCustomerPreference }));

import { CustomerPreferences, type Preference } from './customer-preferences';

const preference: Preference = {
  id: 'p1',
  category: 'communication',
  content: 'Prefers email over SMS',
  provenance: 'merchant_provided',
  createdAt: '2026-01-05T10:00:00.000Z',
  updatedAt: '2026-01-06T10:00:00.000Z',
};

function renderPreferences(preferences: Preference[] = [preference]) {
  render(<CustomerPreferences workspaceId="ws_1" canonicalCustomerId="cust_1" preferences={preferences} />);
}

describe('CustomerPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('adds a trimmed preference with the chosen category, clears the box, then refreshes', async () => {
    createCustomerPreference.mockResolvedValueOnce({});
    renderPreferences([]);

    const box = screen.getByLabelText('New preference') as HTMLTextAreaElement;
    expect(screen.getByRole('button', { name: 'Add preference' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Preference category'), { target: { value: 'product' } });
    fireEvent.change(box, { target: { value: '  Only buys organic cotton  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add preference' }));
    await screen.findByRole('button', { name: 'Add preference' });

    expect(createCustomerPreference).toHaveBeenCalledWith('ws_1', 'cust_1', { category: 'product', content: 'Only buys organic cotton' });
    expect(box.value).toBe('');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error and keeps the draft when adding fails', async () => {
    createCustomerPreference.mockRejectedValueOnce(new Error('down'));
    renderPreferences([]);

    fireEvent.change(screen.getByLabelText('New preference'), { target: { value: 'Note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add preference' }));
    await screen.findByText('Could not add this preference. Please try again.');

    expect((screen.getByLabelText('New preference') as HTMLTextAreaElement).value).toBe('Note');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('marks an edited preference and saves a category + content edit', async () => {
    updateCustomerPreference.mockResolvedValueOnce({});
    renderPreferences();
    expect(screen.getByText(/edited/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit preference category'), { target: { value: 'interaction' } });
    fireEvent.change(screen.getByLabelText('Edit preference'), { target: { value: 'Prefers a phone call' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Edit' });

    expect(updateCustomerPreference).toHaveBeenCalledWith('ws_1', 'cust_1', 'p1', { category: 'interaction', content: 'Prefers a phone call' });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('asks for confirmation before archiving, and cancel archives nothing', async () => {
    archiveCustomerPreference.mockResolvedValueOnce({});
    renderPreferences();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('Archive this preference?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(archiveCustomerPreference).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm archive' }));
    await screen.findByRole('button', { name: 'Confirm archive' });

    expect(archiveCustomerPreference).toHaveBeenCalledWith('ws_1', 'cust_1', 'p1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
