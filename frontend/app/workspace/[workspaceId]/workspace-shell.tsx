'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ComponentType, type SVGProps } from 'react';
import { UserButton } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { RoleBadge } from '@/components/ui/badge';
import {
  AutomationsIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  CustomersIcon,
  DashboardIcon,
  IntegrationsIcon,
  KnowledgeIcon,
  ShieldIcon,
} from '@/components/ui/icons';

type WorkspaceSummary = { id: string; name: string; role: string };
type NavItem = { label: string; href: string; icon: ComponentType<SVGProps<SVGSVGElement>>; exact?: boolean };
type NavGroup = { label: string; items: NavItem[] };

function BraynMark() {
  return (
    <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-primary text-[12px] font-bold leading-none text-primary-foreground">
      B
    </span>
  );
}

/** Switch between the workspaces this user actually belongs to (native disclosure — keyboard/escape handled by the browser). */
function WorkspaceSwitcher({ current, workspaces }: { current: WorkspaceSummary | undefined; workspaces: WorkspaceSummary[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <details ref={ref} className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-foreground">{current?.name ?? 'Workspace'}</span>
          {current?.role && <span className="block text-xs capitalize text-muted-foreground">{current.role}</span>}
        </span>
        <ChevronsUpDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </summary>
      <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-border bg-surface-elevated p-1 shadow-raised">
        <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">Workspaces</p>
        {workspaces.map((workspace) => (
          <Link
            key={workspace.id}
            href={`/workspace/${workspace.id}`}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-foreground hover:bg-subtle"
          >
            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
            {workspace.id === current?.id && <CheckIcon className="h-3.5 w-3.5 shrink-0 text-accent" />}
          </Link>
        ))}
        <div className="my-1 border-t border-border" />
        <Link href="/" className="block rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-subtle hover:text-foreground">
          All workspaces
        </Link>
      </div>
    </details>
  );
}

/**
 * Persistent workspace shell: brand, workspace switcher, grouped navigation
 * and account — the only navigation on every workspace page. Only links to
 * routes that actually exist (doc24's IA lists more areas than are built;
 * those stay out of nav until they are). AI Actions stays owner/admin-only,
 * matching the page's own permission.
 */
export function WorkspaceShell({
  workspaceId,
  workspaces,
  children,
}: {
  workspaceId: string;
  workspaces: WorkspaceSummary[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const current = workspaces.find((workspace) => workspace.id === workspaceId);
  const canManage = current?.role === 'owner' || current?.role === 'admin';
  const base = `/workspace/${workspaceId}`;

  const groups: NavGroup[] = [
    {
      label: 'Workspace',
      items: [
        { label: 'Dashboard', href: base, icon: DashboardIcon, exact: true },
        { label: 'Customers', href: `${base}/customers`, icon: CustomersIcon },
      ],
    },
    {
      label: 'Intelligence',
      items: [
        { label: 'Automations', href: `${base}/automations`, icon: AutomationsIcon },
        { label: 'Knowledge', href: `${base}/knowledge`, icon: KnowledgeIcon },
        ...(canManage ? [{ label: 'AI Actions', href: `${base}/ai-actions`, icon: ShieldIcon }] : []),
      ],
    },
    { label: 'Data', items: [{ label: 'Integrations', href: `${base}/integrations`, icon: IntegrationsIcon }] },
  ];

  function isActive(item: NavItem) {
    if (!pathname) return false;
    return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

  return (
    <div className="min-h-screen md:flex">
      <aside className="hidden shrink-0 md:sticky md:top-0 md:flex md:h-screen md:w-[232px] md:flex-col md:px-3 md:py-3">
        <Link href="/" className="flex items-center gap-2 px-2 py-1.5">
          <BraynMark />
          <span className="text-[15px] font-semibold tracking-tight text-foreground">BRAYN</span>
        </Link>

        <div className="mt-3">
          <WorkspaceSwitcher current={current} workspaces={workspaces} />
        </div>

        <nav aria-label="Workspace" className="mt-4 flex-1 space-y-5 overflow-y-auto">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="px-2 pb-1 text-xs font-medium text-muted-foreground/80">{group.label}</p>
              <ul className="space-y-px">
                {group.items.map((item) => {
                  const active = isActive(item);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors duration-150',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40',
                          active
                            ? 'bg-surface text-foreground shadow-panel ring-1 ring-border'
                            : 'text-foreground/65 hover:bg-foreground/[0.04] hover:text-foreground',
                        )}
                      >
                        <item.icon className={cn('h-4 w-4 shrink-0', active ? 'text-accent' : 'text-muted-foreground group-hover:text-foreground/80')} />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="mt-3 min-w-0 overflow-hidden border-t border-border px-2 pt-3">
          <UserButton
            showName
            appearance={{
              elements: {
                rootBox: 'w-full min-w-0',
                userButtonTrigger: 'w-full min-w-0 rounded-lg focus:shadow-none',
                userButtonBox: 'flex-row-reverse gap-2 min-w-0 w-full justify-end',
                userButtonOuterIdentifier: 'min-w-0 truncate pl-0 text-[13px] font-medium text-foreground',
              },
            }}
          />
        </div>
      </aside>

      <div className="min-w-0 flex-1 md:py-2 md:pr-2">
        {/* Small screens: compact top bar in place of the sidebar. */}
        <div className="border-b border-border bg-surface md:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <Link href="/" className="flex min-w-0 flex-1 items-center gap-2">
              <BraynMark />
              <span className="truncate text-sm font-semibold text-foreground">{current?.name ?? 'BRAYN'}</span>
            </Link>
            <div className="flex shrink-0 items-center gap-2">
              {current?.role && <RoleBadge role={current.role} />}
              <UserButton />
            </div>
          </div>
          <nav aria-label="Workspace" className="flex gap-1 overflow-x-auto px-3 pb-2">
            {groups.flatMap((group) => group.items).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(item) ? 'page' : undefined}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] font-medium',
                  isActive(item) ? 'bg-subtle text-foreground' : 'text-muted-foreground',
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="min-h-[calc(100vh-1rem)] overflow-hidden bg-canvas md:rounded-xl md:border md:border-border md:shadow-raised">{children}</div>
      </div>
    </div>
  );
}
