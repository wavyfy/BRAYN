'use server';

import { apiFetch } from '@/lib/api';

export async function createWorkspace(name: string) {
  return apiFetch('/api/v1/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
}

export async function renameWorkspace(workspaceId: string, name: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}`, { method: 'PATCH', body: JSON.stringify({ name }) });
}

export async function addMember(workspaceId: string, userId: string, role: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId, role }),
  });
}
