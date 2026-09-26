/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AnswerMarkdown } from './answer-markdown';

describe('AnswerMarkdown', () => {
  afterEach(cleanup);

  it('renders **bold** as <strong> without the asterisks', () => {
    const { container } = render(<AnswerMarkdown source="Act on the **VIP recognition opportunity first**." />);

    expect(container.querySelector('strong')?.textContent).toBe('VIP recognition opportunity first');
    expect(container.textContent).toBe('Act on the VIP recognition opportunity first.');
  });

  it('renders "- " / "* " lines as a bullet list, with bold inside items', () => {
    const { container } = render(<AnswerMarkdown source={'**Why:**\n- It has **critical priority**.\n* Maya has placed 12 orders.'} />);

    const items = [...container.querySelectorAll('ul > li')].map((li) => li.textContent);
    expect(items).toEqual(['It has critical priority.', 'Maya has placed 12 orders.']);
    expect(container.querySelector('ul strong')?.textContent).toBe('critical priority');
    expect(container.querySelector('p strong')?.textContent).toBe('Why:');
  });

  it('renders "1." / "2)" lines as a numbered list', () => {
    const { container } = render(<AnswerMarkdown source={'1. VIP recognition\n2) Upsell'} />);

    expect(container.querySelector('ol')).toBeTruthy();
    expect([...container.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual(['VIP recognition', 'Upsell']);
  });

  it('renders # headings as headings, not literal hashes', () => {
    render(<AnswerMarkdown source={'## Recommendation\nDo this.'} />);

    expect(screen.getByRole('heading', { name: 'Recommendation' })).toBeTruthy();
    expect(screen.queryByText(/##/)).toBeNull();
  });

  it('keeps an ordinary plain-text answer as paragraphs, preserving single line breaks', () => {
    const { container } = render(<AnswerMarkdown source={'First paragraph.\nSame paragraph, next line.\n\nSecond paragraph.'} />);

    const paragraphs = [...container.querySelectorAll('p')].map((p) => p.textContent);
    expect(paragraphs).toEqual(['First paragraph.\nSame paragraph, next line.', 'Second paragraph.']);
    expect(container.querySelector('ul, ol, strong')).toBeNull();
  });

  it('leaves an unmatched ** as literal text', () => {
    const { container } = render(<AnswerMarkdown source="Growth of **20% this month." />);

    expect(container.textContent).toBe('Growth of **20% this month.');
    expect(container.querySelector('strong')).toBeNull();
  });

  it('never renders HTML from the model output — tags come through as escaped text', () => {
    const { container } = render(
      <AnswerMarkdown source={'<script>window.__xss = 1</script>\n- <img src=x onerror="window.__xss = 2"> **<b>bold</b>**'} />,
    );

    expect(container.querySelector('script, img, b')).toBeNull();
    expect(container.textContent).toContain('<script>window.__xss = 1</script>');
    expect(container.textContent).toContain('<img src=x onerror="window.__xss = 2">');
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });
});
