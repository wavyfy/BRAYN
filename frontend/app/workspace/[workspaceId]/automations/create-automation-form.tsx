'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createAutomation } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { ErrorText } from '@/components/ui/alert';

const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
const TYPES = ['reorder', 'win_back', 'vip_recognition'] as const;

function toggle<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function CreateAutomationForm({ workspaceId }: { workspaceId: string }) {
  const [name, setName] = useState('');
  const [priorityIn, setPriorityIn] = useState<string[]>([]);
  const [typeIn, setTypeIn] = useState<string[]>([]);
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
          await createAutomation(workspaceId, name, {
            priorityIn: priorityIn.length > 0 ? priorityIn : undefined,
            typeIn: typeIn.length > 0 ? typeIn : undefined,
          });
          setName('');
          setPriorityIn([]);
          setTypeIn([]);
          router.refresh();
        } catch {
          setError('Could not create this automation. Please try again.');
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="automation-name">Name</Label>
          <Input
            id="automation-name"
            type="text"
            placeholder="e.g. Recommend on new opportunity"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add automation'}
        </Button>
      </div>

      <p className="text-xs text-slate-500">Runs when a revenue opportunity is created. Leave a filter empty to match every value.</p>

      <div className="flex flex-wrap gap-6">
        <div className="space-y-1.5">
          <Label>Priority</Label>
          <div className="flex flex-wrap gap-3">
            {PRIORITIES.map((priority) => (
              <label key={priority} className="flex items-center gap-1.5 text-sm capitalize text-slate-700">
                <Checkbox checked={priorityIn.includes(priority)} onChange={() => setPriorityIn((prev) => toggle(prev, priority))} />
                {priority}
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Opportunity type</Label>
          <div className="flex flex-wrap gap-3">
            {TYPES.map((type) => (
              <label key={type} className="flex items-center gap-1.5 text-sm capitalize text-slate-700">
                <Checkbox checked={typeIn.includes(type)} onChange={() => setTypeIn((prev) => toggle(prev, type))} />
                {type.replace('_', ' ')}
              </label>
            ))}
          </div>
        </div>
      </div>

      {error && <ErrorText>{error}</ErrorText>}
    </form>
  );
}
