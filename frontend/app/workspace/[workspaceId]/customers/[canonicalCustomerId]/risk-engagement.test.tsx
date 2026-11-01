/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RiskEngagement, type CustomerHealthState, type HealthHistoryEntry } from './risk-engagement';

const health: CustomerHealthState = {
  score: 62,
  healthCategory: 'Neutral',
  signals: {},
  reasonCodes: [],
  trend: 'improving',
  lastCalculatedAt: '2026-11-01T08:00:00Z',
};

const entry = (day: number, score: number | null, healthCategory: string | null = 'Neutral'): HealthHistoryEntry => ({
  score,
  healthCategory,
  trend: 'stable',
  calculatedAt: `2026-10-${String(day).padStart(2, '0')}T08:00:00Z`,
});

describe('RiskEngagement — score history', () => {
  afterEach(cleanup);

  it('shows no history section until there are two calculations to compare', () => {
    render(<RiskEngagement health={health} history={[entry(30, 62)]} />);

    expect(screen.queryByText('Score history')).toBeNull();
  });

  it('draws the scores oldest → newest and lists the most recent five, newest first', () => {
    const history = [entry(30, 62), entry(29, 55), entry(28, 48, 'At Risk'), entry(27, 40, 'At Risk'), entry(26, 30, 'At Risk'), entry(25, 20, 'Critical')];
    render(<RiskEngagement health={health} history={history} />);

    expect(screen.getByText('Score history')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Score history: 20, 30, 40, 48, 55, 62' })).toBeTruthy();
    const rows = screen.getAllByRole('listitem').filter((li) => /\d{4}|Oct/.test(li.textContent ?? ''));
    expect(rows).toHaveLength(5);
    expect(rows[0]!.textContent).toContain('62');
    expect(rows[0]!.textContent).toContain('stable'); // trend
    expect(rows[0]!.textContent).toMatch(/\d{1,2}:\d{2}/); // time, not just the date — same-day recalculations stay distinguishable
    expect(screen.queryByText('Critical')).toBeNull(); // the 6th (oldest) entry is not listed
  });

  it('skips withheld (null) scores in the line and shows them as — in the list, never as 0', () => {
    render(<RiskEngagement health={health} history={[entry(30, 62), entry(29, null, null), entry(28, 50)]} />);

    expect(screen.getByRole('img', { name: 'Score history: 50, 62' })).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders the existing empty state, without history, when health was never calculated', () => {
    render(<RiskEngagement health={null} history={[entry(30, 62), entry(29, 55)]} />);

    expect(screen.getByText('Not yet calculated for this customer.')).toBeTruthy();
    expect(screen.queryByText('Score history')).toBeNull();
  });
});
