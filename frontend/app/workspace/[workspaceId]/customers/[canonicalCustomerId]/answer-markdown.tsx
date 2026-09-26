import type { ReactNode } from 'react';

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };

  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);

    if (line.trim() === '') {
      flushParagraph();
    } else if (heading) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length as 1 | 2 | 3, text: heading[2] ?? '' });
    } else if (bullet || numbered) {
      flushParagraph();
      const ordered = numbered !== null;
      const text = (bullet ?? numbered)?.[1] ?? '';
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(text);
      else blocks.push({ kind: 'list', ordered, items: [text] });
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  return blocks;
}

/** `**bold**` only — an unmatched `**` is left as literal text rather than guessed at. */
function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.length > 4 && part.startsWith('**') && part.endsWith('**') ? (
      <strong key={index} className="font-semibold text-foreground">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

/**
 * Minimal Markdown for Merchant Business Analyst answers: paragraphs, bold,
 * bullet/numbered lists, and #–### headings — the subset the model actually
 * returns. Built only from React elements (no `dangerouslySetInnerHTML`), so
 * any HTML in the model output is escaped as text, never rendered.
 */
export function AnswerMarkdown({ source }: { source: string }) {
  return (
    <div className="space-y-3 text-[15px] leading-relaxed text-foreground">
      {parseBlocks(source).map((block, index) => {
        if (block.kind === 'heading') {
          return (
            <p key={index} className="pt-1 font-semibold text-foreground" role="heading" aria-level={block.level + 2}>
              {renderInline(block.text)}
            </p>
          );
        }
        if (block.kind === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={index} className={`space-y-1.5 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'} marker:text-muted-foreground`}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="pl-1">
                  {renderInline(item)}
                </li>
              ))}
            </ListTag>
          );
        }
        return (
          <p key={index} className="whitespace-pre-line">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
