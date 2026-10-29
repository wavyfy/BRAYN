/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, createCustomerMemory, updateCustomerMemory, archiveCustomerMemory } = vi.hoisted(() => ({
  refresh: vi.fn(),
  createCustomerMemory: vi.fn(),
  updateCustomerMemory: vi.fn(),
  archiveCustomerMemory: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ createCustomerMemory, updateCustomerMemory, archiveCustomerMemory }));

import { CustomerMemory, type MemoryEntry } from './customer-memory';

const entry: MemoryEntry = {
  id: 'm1',
  content: 'Prefers weekend delivery',
  provenance: 'merchant_provided',
  createdAt: '2026-01-05T10:00:00.000Z',
  updatedAt: '2026-01-06T10:00:00.000Z',
};

function renderMemory(entries: MemoryEntry[] = [entry]) {
  render(<CustomerMemory workspaceId="ws_1" canonicalCustomerId="cust_1" entries={entries} />);
}

describe('CustomerMemory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('adds a trimmed note, clears the box, then refreshes', async () => {
    createCustomerMemory.mockResolvedValueOnce({});
    renderMemory([]);

    const box = screen.getByLabelText('New memory') as HTMLTextAreaElement;
    expect(screen.getByRole('button', { name: 'Add note' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(box, { target: { value: '  Likes gift wrap  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await screen.findByRole('button', { name: 'Add note' });

    expect(createCustomerMemory).toHaveBeenCalledWith('ws_1', 'cust_1', 'Likes gift wrap');
    expect(box.value).toBe('');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error and keeps the draft when adding fails', async () => {
    createCustomerMemory.mockRejectedValueOnce(new Error('down'));
    renderMemory([]);

    fireEvent.change(screen.getByLabelText('New memory'), { target: { value: 'Note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await screen.findByText('Could not add this note. Please try again.');

    expect((screen.getByLabelText('New memory') as HTMLTextAreaElement).value).toBe('Note');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('marks an edited note and saves an edit', async () => {
    updateCustomerMemory.mockResolvedValueOnce({});
    renderMemory();
    expect(screen.getByText(/edited/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit memory'), { target: { value: 'Prefers Saturday delivery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Edit' });

    expect(updateCustomerMemory).toHaveBeenCalledWith('ws_1', 'cust_1', 'm1', 'Prefers Saturday delivery');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('asks for confirmation before archiving, and cancel archives nothing', async () => {
    archiveCustomerMemory.mockResolvedValueOnce({});
    renderMemory();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByText('Archive this note?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(archiveCustomerMemory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm archive' }));
    await screen.findByRole('button', { name: 'Confirm archive' });

    expect(archiveCustomerMemory).toHaveBeenCalledWith('ws_1', 'cust_1', 'm1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
