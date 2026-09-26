'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createAutomation } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { ErrorText } from '@/components/ui/alert';

const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
const TYPES = ['reorder', 'win_back', 'vip_recognition'] as const;

/** The only two trigger types wired on the backend today (createAutomationSchema). */
const TRIGGER_TYPES = [
  { value: 'revenue_opportunity.created', label: 'Revenue opportunity created' },
  { value: 'customer_health.recalculated', label: 'Customer health recalculated' },
] as const;
type AutomationTriggerType = (typeof TRIGGER_TYPES)[number]['value'];

function toggle<T extends string>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function CreateAutomationForm({ workspaceId }: { workspaceId: string }) {
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState<AutomationTriggerType>('revenue_opportunity.created');
  const [priorityIn, setPriorityIn] = useState<string[]>([]);
  const [typeIn, setTypeIn] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const isRevenueOpportunityTrigger = triggerType === 'revenue_opportunity.created';

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        try {
          await createAutomation(
            workspaceId,
            name,
            triggerType,
            // Revenue-opportunity condition fields are meaningless for a health-triggered
            // automation (matchesHealthConditions() doesn't evaluate them) — never sent for one.
            isRevenueOpportunityTrigger
              ? { priorityIn: priorityIn.length > 0 ? priorityIn : undefined, typeIn: typeIn.length > 0 ? typeIn : undefined }
              : undefined,
          );
          setName('');
          setTriggerType('revenue_opportunity.created');
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
      <div className="space-y-3">
        <div className="space-y-1.5">
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
        <div className="space-y-1.5">
          <Label htmlFor="automation-trigger-type">Trigger</Label>
          <Select
            id="automation-trigger-type"
            className="w-full"
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value as AutomationTriggerType)}
          >
            {TRIGGER_TYPES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {isRevenueOpportunityTrigger ? (
        <>
          <p className="text-xs text-muted-foreground">Runs when a revenue opportunity is created. Leave a filter empty to match every value.</p>

          <div className="flex flex-wrap gap-6">
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <div className="flex flex-wrap gap-3">
                {PRIORITIES.map((priority) => (
                  <label key={priority} className="flex items-center gap-1.5 text-sm capitalize text-foreground/80">
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
                  <label key={type} className="flex items-center gap-1.5 text-sm capitalize text-foreground/80">
                    <Checkbox checked={typeIn.includes(type)} onChange={() => setTypeIn((prev) => toggle(prev, type))} />
                    {type.replace('_', ' ')}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Runs every time a customer&apos;s health score is recalculated. Filtering by health status isn&apos;t available yet.
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? 'Adding…' : 'Add automation'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </form>
  );
}
