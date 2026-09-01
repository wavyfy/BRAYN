import { cn } from '@/lib/utils';

/** Doc 28 role catalog — one subtle color per role so a member row reads at a glance. */
const roleStyles: Record<string, string> = {
  owner: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  admin: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  marketing: 'bg-pink-50 text-pink-700 ring-pink-600/20',
  support: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  analyst: 'bg-sky-50 text-sky-700 ring-sky-600/20',
};
const defaultRoleStyle = 'bg-slate-100 text-slate-700 ring-slate-500/20';

export function RoleBadge({ role, className }: { role: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset',
        roleStyles[role] ?? defaultRoleStyle,
        className,
      )}
    >
      {role}
    </span>
  );
}
