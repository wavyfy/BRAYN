import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAILY_RUN_FRESHNESS_DEADLINE_HOURS } from './intelligence-daily-run.service';

// The scheduler lives in a GitHub Actions workflow; this ties it to the deadline the monitor alerts on.
const workflow = readFileSync(join(__dirname, '../../../../.github/workflows/daily-intelligence-run.yml'), 'utf8');

function scheduledMinutesOfDay(): number[] {
  const crons = [...workflow.matchAll(/^\s*- cron: '([^']+)'/gm)].map((match) => match[1]);
  expect(crons).toHaveLength(1);
  const [minute, hours, ...rest] = crons[0].split(' ');
  expect(rest).toEqual(['*', '*', '*']);
  expect(minute).toMatch(/^\d+$/);
  return hours.split(',').map((hour) => Number(hour) * 60 + Number(minute));
}

describe('daily-run workflow schedule', () => {
  it('has two start attempts before the monitor freshness deadline, so one dropped slot does not miss it', () => {
    const early = scheduledMinutesOfDay().filter((at) => at < DAILY_RUN_FRESHNESS_DEADLINE_HOURS * 60);
    expect(early.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves the first attempt at least two hours before the deadline (GitHub starts schedules late)', () => {
    const first = Math.min(...scheduledMinutesOfDay());
    expect(DAILY_RUN_FRESHNESS_DEADLINE_HOURS * 60 - first).toBeGreaterThanOrEqual(120);
  });

  it('avoids the top of the hour', () => {
    for (const at of scheduledMinutesOfDay()) expect(at % 60).not.toBe(0);
  });

  it('never runs two workflow jobs at once and never cancels a run in progress', () => {
    expect(workflow).toMatch(/concurrency:\s*\n\s*group: daily-intelligence-run\s*\n\s*cancel-in-progress: false/);
  });
});
