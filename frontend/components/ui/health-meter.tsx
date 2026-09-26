import { cn } from '@/lib/utils';

type Tone = 'success' | 'warning' | 'danger';

const SIZE = 72;
const STROKE = 6;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * UI-only score banding for the ring color. doc10 defines "Fixed Phase 1
 * health categories" but not their thresholds or exact strings, and
 * `healthCategory` is deliberately untyped free text never yet populated by
 * any backend slice — so tone is derived from the numeric `score` only, not
 * from `healthCategory`, which this component doesn't render at all.
 */
function scoreTone(score: number): Tone {
  if (score >= 70) return 'success';
  if (score >= 40) return 'warning';
  return 'danger';
}

const ringToneClass: Record<Tone, string> = {
  success: 'stroke-success',
  warning: 'stroke-warning',
  danger: 'stroke-danger',
};

const textToneClass: Record<Tone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

/** Customer Risk & Engagement State score (doc10) — a ring for a number, an honest withheld state for `null`, never a fake/zero score. */
export function HealthMeter({ score, className }: { score: number | null; className?: string }) {
  if (score === null) {
    return (
      <div className={cn('flex items-center gap-3.5', className)}>
        <svg width={SIZE} height={SIZE} className="shrink-0" role="img" aria-label="Health score withheld">
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} strokeWidth={STROKE} fill="none" strokeDasharray="3 5" className="stroke-muted-foreground/30" />
          <text x={SIZE / 2} y={SIZE / 2} textAnchor="middle" dominantBaseline="central" fill="currentColor" className="text-lg font-medium text-muted-foreground/60">
            –
          </text>
        </svg>
        <div>
          <p className="text-sm font-semibold text-foreground">Score withheld</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Not enough signal coverage yet.</p>
        </div>
      </div>
    );
  }

  const clamped = Math.max(0, Math.min(100, score));
  const tone = scoreTone(clamped);
  const offset = CIRCUMFERENCE * (1 - clamped / 100);

  return (
    <div className={cn('flex items-center gap-3.5', className)}>
      <svg width={SIZE} height={SIZE} className="shrink-0" role="img" aria-label={`Health score ${clamped} out of 100`}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} strokeWidth={STROKE} fill="none" className="stroke-muted-foreground/15" />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          strokeWidth={STROKE}
          fill="none"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          className={cn(ringToneClass[tone], 'transition-[stroke-dashoffset]')}
        />
        <text x={SIZE / 2} y={SIZE / 2} textAnchor="middle" dominantBaseline="central" fill="currentColor" className={cn('text-lg font-semibold', textToneClass[tone])}>
          {clamped}
        </text>
      </svg>
      <div>
        <p className={cn('text-sm font-semibold', textToneClass[tone])}>{clamped}/100</p>
      </div>
    </div>
  );
}
