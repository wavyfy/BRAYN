'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { disconnectIntegration, startIntegrationImport } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/alert';

export type ImportRun = {
  status: 'running' | 'succeeded' | 'failed' | 'partial';
  recordsImported: number;
  recordsFailed: number;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

/** Connected-state controls: start import, show import/sync status and errors, disconnect. */
export function IntegrationActions({
  workspaceId,
  provider,
  providerLabel,
  status,
  lastSyncedAt,
  lastSyncError,
  latestImport,
}: {
  workspaceId: string;
  provider: string;
  providerLabel: string;
  status: string;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  latestImport: ImportRun | null;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function run(action: () => Promise<unknown>, failureMessage: string) {
    setPending(true);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch {
      setError(failureMessage);
    } finally {
      setPending(false);
    }
  }

  const importRunning = latestImport?.status === 'running';

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-slate-500">Last synced</dt>
          <dd className="mt-0.5 text-slate-900">{formatDate(lastSyncedAt)}</dd>
        </div>
      </dl>
      {lastSyncError && <ErrorText>{lastSyncError}</ErrorText>}

      {latestImport && (
        <div className="rounded-md bg-slate-50 px-3 py-2 text-sm">
          <p className="font-medium text-slate-900">Import {importRunning ? 'in progress…' : latestImport.status}</p>
          <p className="text-slate-600">
            {latestImport.recordsImported} imported
            {latestImport.recordsFailed > 0 ? `, ${latestImport.recordsFailed} failed` : ''}
          </p>
          {latestImport.error && <ErrorText className="mt-1">{latestImport.error}</ErrorText>}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={pending || importRunning || status === 'syncing'}
          onClick={() => run(() => startIntegrationImport(workspaceId, provider), 'Could not start the import.')}
        >
          {importRunning ? 'Import running…' : 'Start import'}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={pending}
          onClick={() => {
            if (window.confirm(`Disconnect ${providerLabel}? You'll need to re-enter credentials to reconnect.`)) {
              run(() => disconnectIntegration(workspaceId, provider), 'Could not disconnect.');
            }
          }}
        >
          Disconnect
        </Button>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
