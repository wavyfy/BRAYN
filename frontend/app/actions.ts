'use server';

import { apiFetch } from '@/lib/api';

export async function createWorkspace(name: string) {
  return apiFetch('/api/v1/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
}
