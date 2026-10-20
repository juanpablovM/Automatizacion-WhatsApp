// =============================================================================
// Detect positional placeholders ($1, $2, ...) documented inside SQL comments.
// -----------------------------------------------------------------------------
// The n8n Postgres node renders positional parameters through pg-promise, which
// substitutes $N on the query TEXT before PostgreSQL ever parses it. Comments
// are substituted too, so a value carrying a newline escapes a `--` comment and
// everything after the newline becomes an executable statement.
//
// Document parameters as pN (p1, p2, ...) instead of $N. The placeholders
// themselves stay $N in executable positions, where pg-promise quotes them.
// =============================================================================

const PLACEHOLDER = /\$\d+/g;

const isDollarTagChar = (char, first) =>
  first ? /[A-Za-z_]/.test(char) : /[A-Za-z0-9_]/.test(char);

// Reads a dollar-quote opener at `index` ($$ or $tag$) and returns its literal
// text, or null when the $ starts something else (a positional placeholder).
function readDollarTag(sql, index) {
  let cursor = index + 1;
  while (cursor < sql.length && sql[cursor] !== '$') {
    if (!isDollarTagChar(sql[cursor], cursor === index + 1)) return null;
    cursor += 1;
  }
  if (cursor >= sql.length) return null;
  return sql.slice(index, cursor + 1);
}

/**
 * Splits SQL into contiguous regions classified as code, comment or string.
 * Regions carry their absolute offsets plus the 1-based line and column of
 * their first character.
 */
export function scanRegions(sql) {
  const regions = [];
  let kind = 'code';
  let start = 0;
  let line = 1;
  let column = 1;
  let startLine = 1;
  let startColumn = 1;
  let blockDepth = 0;
  let dollarTag = null;
  let index = 0;

  const close = (end, nextKind) => {
    if (end > start) {
      regions.push({
        kind,
        text: sql.slice(start, end),
        start,
        end,
        line: startLine,
        column: startColumn,
      });
    }
    kind = nextKind;
    start = end;
    startLine = line;
    startColumn = column;
  };

  const advance = (count) => {
    for (let step = 0; step < count; step += 1) {
      if (sql[index] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (kind === 'code') {
      if (char === '-' && next === '-') {
        close(index, 'comment');
        advance(2);
        continue;
      }
      if (char === '/' && next === '*') {
        close(index, 'comment');
        blockDepth = 1;
        advance(2);
        continue;
      }
      if (char === "'" || char === '"') {
        close(index, 'string');
        dollarTag = char;
        advance(1);
        continue;
      }
      if (char === '$') {
        const tag = readDollarTag(sql, index);
        if (tag) {
          close(index, 'string');
          dollarTag = tag;
          advance(tag.length);
          continue;
        }
      }
      advance(1);
      continue;
    }

    if (kind === 'comment') {
      if (blockDepth === 0) {
        if (char === '\n') {
          close(index, 'code');
          continue;
        }
        advance(1);
        continue;
      }
      if (char === '/' && next === '*') {
        blockDepth += 1;
        advance(2);
        continue;
      }
      if (char === '*' && next === '/') {
        blockDepth -= 1;
        advance(2);
        if (blockDepth === 0) close(index, 'code');
        continue;
      }
      advance(1);
      continue;
    }

    // kind === 'string'
    if (dollarTag === "'" || dollarTag === '"') {
      if (char === dollarTag && next === dollarTag) {
        advance(2);
        continue;
      }
      if (char === dollarTag) {
        advance(1);
        close(index, 'code');
        continue;
      }
      advance(1);
      continue;
    }
    if (char === '$' && sql.startsWith(dollarTag, index)) {
      advance(dollarTag.length);
      close(index, 'code');
      continue;
    }
    advance(1);
  }

  close(sql.length, kind);
  return regions;
}

/**
 * Returns every positional placeholder that sits inside a comment, which is
 * where pg-promise substitution can break the statement apart.
 */
export function findCommentPlaceholders(sql) {
  const findings = [];
  for (const region of scanRegions(sql)) {
    if (region.kind !== 'comment') continue;
    for (const match of region.text.matchAll(PLACEHOLDER)) {
      const prefix = region.text.slice(0, match.index);
      const newlines = prefix.split('\n').length - 1;
      const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
      findings.push({
        token: match[0],
        line: region.line + newlines,
        column: newlines === 0 ? region.column + prefix.length : lastLine.length + 1,
        text: region.text.split('\n')[newlines].trim(),
      });
    }
  }
  return findings;
}
