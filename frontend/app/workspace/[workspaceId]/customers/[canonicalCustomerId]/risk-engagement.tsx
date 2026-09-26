import { HealthMeter } from '@/components/ui/health-meter';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDateTime, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

export type HealthSignal = { available: boolean; weight?: number; value?: number | null; score?: number; reasonCode?: string; reason?: string };
export type CustomerHealthState = {
  score: number | null;
  healthCategory: string | null;
  signals: Record<string, HealthSignal>;
  reasonCodes: string[];
  trend: string | null;
  lastCalculatedAt: string;
};

/** Display names for the signal keys CustomerHealthService returns today; any other key falls back to its humanized name. */
const signalLabels: Record<string, string> = {
  purchaseRecency: 'Purchase recency',
  purchaseFrequency: 'Purchase frequency',
  websiteEngagement: 'Website engagement',
  whatsappEngagement: 'WhatsApp engagement',
  emailEngagement: 'Email engagement',
  customerExperience: 'Customer experience',
};

function signalLabel(key: string): string {
  if (signalLabels[key]) return signalLabels[key];
  const words = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Share of the backend's own signal weight that is available — only when every signal carries a weight, never estimated. */
function coveragePercent(signals: HealthSignal[]): number | null {
  if (signals.length === 0 || signals.some((signal) => typeof signal.weight !== 'number')) return null;
  const total = signals.reduce((sum, signal) => sum + (signal.weight as number), 0);
  if (total === 0) return null;
  const available = signals.filter((signal) => signal.available).reduce((sum, signal) => sum + (signal.weight as number), 0);
  return Math.round((available / total) * 100);
}

/** One segment per signal, sized by the backend's weight — filled when BRAYN has that signal, hollow when it doesn't. */
function CoverageBar({ entries }: { entries: [string, HealthSignal][] }) {
  return (
    <div className="mt-2 flex h-1.5 gap-0.5" aria-hidden>
      {entries.map(([name, signal]) => (
        <span
          key={name}
          title={`${signalLabel(name)}${signal.available ? '' : ' — not available yet'}`}
          className={cn('h-full rounded-full', signal.available ? 'bg-foreground/70' : 'bg-subtle ring-1 ring-inset ring-border-strong')}
          style={{ flexGrow: signal.weight ?? 1, flexBasis: 0 }}
        />
      ))}
    </div>
  );
}

function SignalRow({ name, signal }: { name: string; signal: HealthSignal }) {
  const label = signalLabel(name);
  const score = signal.available && typeof signal.score === 'number' ? Math.max(0, Math.min(100, signal.score)) : null;

  if (score === null) {
    return (
      <li className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-xs text-muted-foreground/80">Not available yet</span>
      </li>
    );
  }

  return (
    <li className="py-2">
      <div className="grid grid-cols-[minmax(0,1fr)_72px_28px] items-center gap-3 text-[13px]">
        <span className="truncate text-foreground">{label}</span>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-subtle"
          role="meter"
          aria-label={`${label} score`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={score}
        >
          <div className="h-full rounded-full bg-foreground/70" style={{ width: `${score}%` }} />
        </div>
        <span className="text-right font-medium tabular-nums text-foreground">{score}</span>
      </div>
      {signal.reasonCode && <p className="mt-0.5 text-xs text-muted-foreground">{signal.reasonCode}</p>}
    </li>
  );
}

/**
 * Customer Risk & Engagement State (doc10) exactly as CustomerHealthService
 * returns it: the existing HealthMeter for the overall score (numeric or
 * withheld), signal coverage from the backend's own weights, then each
 * signal — scored ones first. Trend and category render only when the
 * backend provides them. With no structured signals (older payload shape),
 * the backend's own reason codes are shown instead.
 */
export function RiskEngagement({ health }: { health: CustomerHealthState | null }) {
  if (!health) {
    return <p className="py-2 text-[13px] text-muted-foreground">Not yet calculated for this customer.</p>;
  }

  // jsonb doesn't keep key order — available signals first, then by the backend's own weight.
  const entries = Object.entries(health.signals ?? {}).sort(
    ([, a], [, b]) => Number(b.available) - Number(a.available) || (b.weight ?? 0) - (a.weight ?? 0),
  );
  const coverage = coveragePercent(entries.map(([, signal]) => signal));
  const scored = entries.filter(([, signal]) => signal.available);
  const missing = entries.filter(([, signal]) => !signal.available);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <HealthMeter score={health.score} />
        {(health.healthCategory || health.trend) && (
          <div className="flex flex-wrap gap-1.5">
            {health.healthCategory && (
              <StatusBadge tone="neutral" className="capitalize">
                {health.healthCategory}
              </StatusBadge>
            )}
            {health.trend && <StatusBadge tone="neutral">Trend: {health.trend}</StatusBadge>}
          </div>
        )}
      </div>

      {coverage !== null && (
        <div className="mt-4">
          <p className="text-[13px] text-muted-foreground">
            <span className="font-medium text-foreground">{coverage}%</span> of the signal weight is available
            {health.score === null ? ', not enough for an overall score yet.' : '.'}
          </p>
          <CoverageBar entries={entries} />
        </div>
      )}

      {entries.length > 0 ? (
        <>
          {scored.length > 0 && (
            <ul className="mt-4 divide-y divide-border border-t border-border">
              {scored.map(([name, signal]) => (
                <SignalRow key={name} name={name} signal={signal} />
              ))}
            </ul>
          )}
          {missing.length > 0 && (
            <ul className={cn('border-t border-border pt-1', scored.length === 0 && 'mt-4')}>
              {missing.map(([name, signal]) => (
                <SignalRow key={name} name={name} signal={signal} />
              ))}
            </ul>
          )}
        </>
      ) : (
        health.reasonCodes.length > 0 && (
          <ul className="mt-4 space-y-1 text-[13px] text-muted-foreground">
            {health.reasonCodes.map((reasonCode) => (
              <li key={reasonCode}>{reasonCode}</li>
            ))}
          </ul>
        )
      )}

      <p className="mt-3 text-xs text-muted-foreground/80" title={formatDateTime(health.lastCalculatedAt)}>
        Calculated {formatRelative(health.lastCalculatedAt)}
      </p>
    </div>
  );
}
