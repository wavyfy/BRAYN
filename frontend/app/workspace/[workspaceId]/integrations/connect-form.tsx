'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { connectProviderWithCredentials } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorText } from '@/components/ui/alert';

export type CredentialField = { name: string; label: string; placeholder?: string; type?: 'text' | 'password' };

/**
 * Generic credential-entry form shared by every provider: field shape is
 * the only thing that differs (Shopify: shopDomain/accessToken;
 * WooCommerce: storeUrl/consumerKey/consumerSecret) — see
 * provider-adapter.interface.ts, `credentials: Record<string, string>` is
 * deliberately provider-agnostic there too.
 */
export function ConnectForm({ workspaceId, provider, providerLabel, fields }: { workspaceId: string; provider: string; providerLabel: string; fields: CredentialField[] }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, ''])));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        try {
          await connectProviderWithCredentials(workspaceId, provider, values);
          router.refresh();
        } catch {
          setError('Could not verify these credentials with ' + providerLabel + '. Check the values and try again.');
        } finally {
          setPending(false);
        }
      }}
    >
      {fields.map((field) => (
        <div key={field.name} className="space-y-1.5">
          <Label htmlFor={`${provider}-${field.name}`}>{field.label}</Label>
          <Input
            id={`${provider}-${field.name}`}
            type={field.type ?? 'text'}
            placeholder={field.placeholder}
            value={values[field.name]}
            onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
            autoComplete="off"
            required
          />
        </div>
      ))}
      <Button type="submit" disabled={pending}>
        {pending ? 'Connecting…' : 'Connect'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </form>
  );
}
