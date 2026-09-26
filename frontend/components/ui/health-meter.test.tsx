/** @vitest-environment jsdom */
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HealthMeter } from './health-meter';

describe('HealthMeter', () => {
  afterEach(cleanup);

  it('renders an honest withheld state for a null score — never a fake number or 0', () => {
    render(<HealthMeter score={null} />);

    expect(screen.getByText('Score withheld')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
    expect(screen.queryByText('0/100')).toBeNull();
  });

  it('renders the numeric score out of 100 when available', () => {
    render(<HealthMeter score={72} />);

    expect(screen.getByText('72/100')).toBeTruthy();
  });

  it('clamps an out-of-range score into 0-100', () => {
    render(<HealthMeter score={140} />);

    expect(screen.getByText('100/100')).toBeTruthy();
  });
});
