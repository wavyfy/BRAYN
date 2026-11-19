/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, replace, eraseCustomer } = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  eraseCustomer: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, replace }) }));
vi.mock('@/app/actions', () => ({ eraseCustomer }));

import { ERASURE_CONFIRMATION, EraseCustomerButton, erasureErrorMessage } from './erase-customer-button';

function openDialog() {
  render(<EraseCustomerButton workspaceId="ws_1" canonicalCustomerId="cust_1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Erase customer' }));
  return screen.getByRole('dialog', { name: 'Erase this customer permanently?' });
}
const confirmInput = () => screen.getByLabelText(/to confirm/);
const confirmButton = () => screen.getAllByRole('button', { name: /Erase customer|Erasing/ }).at(-1)!;

describe('EraseCustomerButton', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('opening the dialog sends nothing; it explains the erasure is permanent and workspace-wide', () => {
    const dialog = openDialog();

    expect(eraseCustomer).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('This cannot be undone.');
    expect(dialog.textContent).toContain('every connected store');
    expect(dialog.textContent).toContain('their orders');
    expect(confirmButton().hasAttribute('disabled')).toBe(true);
  });

  it('the erase button stays disabled until the exact phrase is typed (case and spacing matter)', () => {
    openDialog();
    for (const attempt of ['erase customer', 'ERASE', ' ERASE CUSTOMER', 'ERASE CUSTOMER ']) {
      fireEvent.change(confirmInput(), { target: { value: attempt } });
      expect(confirmButton().hasAttribute('disabled')).toBe(true);
    }
    fireEvent.submit(confirmInput().closest('form')!);
    expect(eraseCustomer).not.toHaveBeenCalled();

    fireEvent.change(confirmInput(), { target: { value: ERASURE_CONFIRMATION } });
    expect(confirmButton().hasAttribute('disabled')).toBe(false);
  });

  it('cancel (button, Escape or backdrop) closes without erasing and clears what was typed', () => {
    openDialog();
    fireEvent.change(confirmInput(), { target: { value: ERASURE_CONFIRMATION } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Erase customer' }));
    expect((confirmInput() as HTMLInputElement).value).toBe('');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Erase customer' }));
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(eraseCustomer).not.toHaveBeenCalled();
  });

  it('on success: sends the typed phrase once, then leaves the deleted customer for the list and refreshes', async () => {
    eraseCustomer.mockResolvedValueOnce({ ok: true });
    openDialog();
    fireEvent.change(confirmInput(), { target: { value: ERASURE_CONFIRMATION } });
    fireEvent.click(confirmButton());

    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/workspace/ws_1/customers?erased=1'));
    expect(eraseCustomer).toHaveBeenCalledTimes(1);
    expect(eraseCustomer).toHaveBeenCalledWith('ws_1', 'cust_1', ERASURE_CONFIRMATION);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 409, 503, 500])('a %i failure shows its own message, keeps the dialog open and does not navigate', async (status) => {
    eraseCustomer.mockResolvedValueOnce({ ok: false, status });
    openDialog();
    fireEvent.change(confirmInput(), { target: { value: ERASURE_CONFIRMATION } });
    fireEvent.click(confirmButton());

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', erasureErrorMessage(status));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(confirmButton().hasAttribute('disabled')).toBe(false);
  });

  it('error messages are distinct per status and never mention customer data', () => {
    const messages = [400, 401, 403, 404, 409, 503, 500].map(erasureErrorMessage);
    expect(new Set(messages).size).toBe(messages.length);
    expect(erasureErrorMessage(403)).toContain('owner');
    expect(erasureErrorMessage(503)).toContain('Nothing was erased');
  });

  it('an unexpected thrown error shows the generic message', async () => {
    eraseCustomer.mockRejectedValueOnce(new Error('network down'));
    openDialog();
    fireEvent.change(confirmInput(), { target: { value: ERASURE_CONFIRMATION } });
    fireEvent.click(confirmButton());

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', erasureErrorMessage(0));
    expect(replace).not.toHaveBeenCalled();
  });
});
