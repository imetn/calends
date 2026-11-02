import type { ReactNode } from 'react';
import './copy.css';

/**
 * Translation templates separate independent facts with newlines, never user-name punctuation.
 * A leading or trailing newline separates the copy from its neighbour: that gap sits outside the
 * wrapping group, so a group that wraps onto its own line starts flush instead of indented.
 * A leading word space (" 发起") is kept as ordinary text so it reads like its untouched siblings.
 */
export function copyParts(value: ReactNode): ReactNode {
  if (typeof value !== 'string' || !value.includes('\n')) return value;
  const parts = value
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);
  const lead = /^[ \t]*\n/.test(value);
  const trail = /\n[ \t]*$/.test(value);
  if (!parts.length) return <span className="copy-gap" aria-hidden="true" />;
  const group = (
    <span className="copy-parts">
      {parts.map((part, i) => (
        <span key={i}>{part}</span>
      ))}
    </span>
  );
  const before = lead ? <span className="copy-gap" aria-hidden="true" /> : value.startsWith(' ') && ' ';
  const after = trail ? <span className="copy-gap" aria-hidden="true" /> : value.endsWith(' ') && ' ';
  if (!before && !after) return group;
  return (
    <>
      {before}
      {group}
      {after}
    </>
  );
}
