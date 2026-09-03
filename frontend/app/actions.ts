'use server';

import { apiFetch, ApiError } from '@/lib/api';

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

export async function updateMemberRole(workspaceId: string, userId: string, role: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/members/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

export async function removeMember(workspaceId: string, userId: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' });
}

export async function transferOwnership(workspaceId: string, userId: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/members/${userId}/ownership-transfer`, { method: 'POST' });
}

export async function recalculateCustomerHealth(workspaceId: string, canonicalCustomerId: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/customers/${canonicalCustomerId}/health/recalculate`, {
    method: 'POST',
  });
}

export async function detectRevenueOpportunities(workspaceId: string, canonicalCustomerId: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/customers/${canonicalCustomerId}/opportunities/detect`, {
    method: 'POST',
  });
}

export async function generateRecommendations(workspaceId: string, canonicalCustomerId: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/customers/${canonicalCustomerId}/recommendations/generate`, {
    method: 'POST',
  });
}

export async function dismissRecommendation(workspaceId: string, canonicalCustomerId: string, recommendationId: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/customers/${canonicalCustomerId}/recommendations/${recommendationId}/dismiss`, {
    method: 'POST',
  });
}

export async function connectIntegration(workspaceId: string, provider: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/integrations`, {
    method: 'POST',
    body: JSON.stringify({ provider }),
  });
}

export async function connectIntegrationCredentials(workspaceId: string, provider: string, credentials: Record<string, string>) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/integrations/${provider}/credentials`, {
    method: 'POST',
    body: JSON.stringify({ credentials }),
  });
}

/**
 * Orchestrates the two-step backend connect flow (POST /integrations then
 * POST /integrations/:provider/credentials — see integration.service.ts)
 * as one action so the connect form only needs one call. A 409 from the
 * first step just means this provider already has a row (e.g. reconnecting
 * after disconnect) — harmless, continue to verify/store the credentials.
 */
export async function connectProviderWithCredentials(workspaceId: string, provider: string, credentials: Record<string, string>) {
  try {
    await connectIntegration(workspaceId, provider);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) {
      throw error;
    }
  }
  await connectIntegrationCredentials(workspaceId, provider, credentials);
}

export async function startIntegrationImport(workspaceId: string, provider: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/integrations/${provider}/import`, { method: 'POST' });
}

export async function disconnectIntegration(workspaceId: string, provider: string) {
  return apiFetch(`/api/v1/workspaces/${workspaceId}/integrations/${provider}`, { method: 'DELETE' });
}
