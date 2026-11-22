// makefun-site 1.0.0 — solve.js
// Dependency-free ES module. run(input) returns the exact output tree:
// a plain object mapping output paths to file text.
// Implemented from sitegen-spec.md (S1: correctness first).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Constant whitespace table for /\s/ (JS): single array lookup per char.
// Module-level constant, not input-keyed state.
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
for (let c = 8192; c <= 8202; c++) WS_TABLE[c] = 1;

const ESC_HTML_RE = /[&<>"']/g;
const INLINE_RE = /[\\`*\[&<>"']/g;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const KNOWN_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const BLANK_RE = /^[ \t]*$/;
const FM_LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LAYOUT_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function escChar(c) { return HTML_ESC[c] || c; }
// Fast escape: native regex scan; chunks with no special char are copied
// verbatim, and a string with no special char is returned as-is.
function escapeHtml(t) {
  ESC_HTML_RE.lastIndex = 0;
  let m;
  let out = '';
  let last = 0;
  while ((m = ESC_HTML_RE.exec(t)) !== null) {
    if (m.index > last) out += t.slice(last, m.index);
    out += HTML_ESC[m[0]];
    last = m.index + 1;
  }
  return last === 0 ? t : out + t.slice(last);
}
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}
function fail(msg) { throw new Error(msg); }

// ---- 0. Text primitives ----

function slugify(text) {
  const norm = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < norm.length; i++) {
    const code = norm.charCodeAt(i);
    if (code >= 65 && code <= 90) { // A-Z
      if (gap) { out += '-'; gap = false; }
      out += String.fromCharCode(code + 32);
    } else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) { // a-z 0-9
      if (gap) { out += '-'; gap = false; }
      out += norm[i];
    } else {
      if (out !== '') gap = true;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}
// Per-run memoised slugify (cache lives and dies inside one run() call).
function slugCached(cache, text) {
  let s = cache.get(text);
  if (s === undefined) { s = slugify(text); cache.set(text, s); }
  return s;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  while (taken.has(slug + '-' + n)) n++;
  const s = slug + '-' + n;
  taken.add(s);
  return s;
}

function longDate(d) {
  const p = d.split('-');
  return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1] + ' ' + p[0];
}

function wordsOf(text) {
  // Manual /\S+/ count: no regex, no match array allocation.
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

function daysInMonth(y, mo) {
  if (mo === 2) return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
  if (mo === 4 || mo === 6 || mo === 9 || mo === 11) return 30;
  return 31;
}

// /^[A-Za-z][A-Za-z0-9+.-]*:/ — manual scan (hot: every link target).
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true; // ':'
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)
      || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

// ---- 3. Front matter ----

function parseStringValue(key, raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') {
      fail('key "' + key + '": a quoted string is not closed');
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        if (i === raw.length - 2) {
          fail('key "' + key + '": a quoted string holds an escape other than \\" or \\');
        }
        const nx = raw[i + 1];
        if (nx === '"' || nx === '\\') { out += nx; i++; }
        else fail('key "' + key + '": a quoted string holds an escape other than \\" or \\');
      } else if (c === '"') {
        fail('key "' + key + '": a quoted string holds a stray quote');
      } else {
        out += c;
      }
    }
    return out;
  }
  if (raw[0] === '[') fail('key "' + key + '": a bare string opens on [');
  return raw;
}

function parseValue(key, raw) {
  if (key === 'title' || key === 'summary') return parseStringValue(key, raw);
  if (key === 'date') {
    const m = DATE_RE.exec(raw);
    if (!m) fail('key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
      fail('key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
    }
    return raw;
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) fail('key "tags": not a list [a, b]');
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return [];
    const parts = inner.split(',');
    const out = [];
    for (const p of parts) {
      const t = p.trim();
      if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
        fail('key "tags": an empty tag, or one holding " [ or ]');
      }
      out.push(t);
    }
    return out;
  }
  if (key === 'draft') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    fail('key "draft": true or false');
  }
  if (key === 'layout') {
    if (!LAYOUT_RE.test(raw)) fail('key "layout": not a template name');
    return raw;
  }
  if (key === 'slug') {
    if (!SLUG_RE.test(raw) || raw.length > 64) fail('key "slug": not a slug');
    return raw;
  }
  return raw; // unreachable
}

function parseFrontMatter(text) {
  // Scan lines with indexOf only; the body is sliced, never split,
  // so a large body costs no line array.
  const firstNL = text.indexOf('\n');
  const first = firstNL === -1 ? text : text.slice(0, firstNL);
  if (first !== '---') fail('no front matter');
  let close = -1;
  let bodyStart = text.length;
  let pos = firstNL === -1 ? text.length : firstNL + 1;
  for (let lineIdx = 1; ; lineIdx++) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') { close = lineIdx; bodyStart = nl === -1 ? text.length : nl + 1; break; }
    if (nl === -1) break;
    pos = nl + 1;
    // A line was just consumed; if text ended with '\n', the next
    // iteration reads the final '' line (never '---'), then stops.
    if (pos >= text.length) {
      // One last line remains only when text ends with '\n' (it is '');
      // it cannot be '---', so stop here.
      break;
    }
  }
  if (close === -1) fail('the front matter is not closed');
  const data = {};
  const seen = new Set();
  pos = firstNL === -1 ? text.length : firstNL + 1;
  for (let i = 1; i < close; i++) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    pos = nl === -1 ? text.length : nl + 1;
    if (isBlankLine(line)) continue;
    if (line[0] === '#') continue;
    const m = FM_LINE_RE.exec(line);
    if (!m) fail('line ' + (i + 1) + ' is not "key: value"');
    const key = m[1];
    const raw = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
    if (!KNOWN_KEYS.has(key)) fail('unknown key "' + key + '"');
    if (seen.has(key)) fail('key "' + key + '" is given twice');
    seen.add(key);
    if (raw === '') fail('key "' + key + '" has no value');
    data[key] = parseValue(key, raw);
  }
  if (!Object.hasOwn(data, 'title')) fail('no title');
  return { data, body: text.slice(bodyStart) };
}

// ---- 6. Markdown ----

function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s[j] !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function inline(s, linkFn) {
  // Jump between special chars with a native regex scan instead of a
  // per-char JS loop. lastIndex is (re)set before every exec, so the
  // recursive inline() calls for strong/em/link contents cannot corrupt
  // this call's scan position. Plain runs between specials are sliced
  // verbatim (no HTML special can hide in them); a lone \, `, * or [
  // that fails its construct stays inside the chunk, exactly the literal
  // output the char-by-char version produced.
  const out = [];
  let i = 0;
  let last = 0;
  const n = s.length;
  const flush = (to) => { if (last < to) out.push(s.slice(last, to)); };
  while (i < n) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null) break;
    i = m.index;
    const code = s.charCodeAt(i);
    if (code === 92) { // backslash
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        flush(i);
        out.push(escChar(s[i + 1]));
        i += 2;
        last = i;
      } else i++;
      continue;
    }
    if (code === 96) { // backtick
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>');
        i = j + 1;
        last = i;
      } else i++;
      continue;
    }
    if (code === 42) { // *
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>' + inline(s.slice(i + 2, j), linkFn) + '</strong>');
          i = j + 2;
          last = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out.push('<em>' + inline(s.slice(i + 1, j), linkFn) + '</em>');
        i = j + 1;
        last = i;
      } else i++;
      continue;
    }
    if (code === 91) { // [
      const k = findUnescaped(s, ']', i + 1);
      let mm = -1;
      if (k !== -1 && s[k + 1] === '(') mm = s.indexOf(')', k + 2);
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out.push('<a href="' + escapeHtml(linkFn(target)) + '">' + inline(s.slice(i + 1, k), linkFn) + '</a>');
        i = mm + 1;
        last = i;
      } else i++;
      continue;
    }
    // & < > " ' — an HTML special.
    flush(i);
    out.push(HTML_ESC[s[i]]);
    i++;
    last = i;
  }
  flush(n);
  return out.join('');
}

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function isWSCode(c) { // JS \s (lines never contain \n/\r, included anyway)
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13
    || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232
    || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}
// Manual equivalents of the block regexes (hot: every source line).
function fenceOpen(line) { // returns lang string, or null
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function headingInfo(line) { // returns {depth, text}, or null
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 35) i++;
  if (i === 0 || i > 6) return null;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  let j = i;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j >= line.length) return null;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  return { depth: i, text: line.slice(j, end) };
}
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false; // '-' or '*'
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
function bulletInfo(line) { // returns item text, or null
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}
function orderedInfo(line) { // returns {start, text}, or null
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null; // '. '
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}
function isContinuation(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWSCode(line.charCodeAt(i));
}

function renderMarkdown(body, linkFn, slugCache) {
  // Lex + render fused in one pass: no intermediate block objects, no
  // second walk. Block boundaries and rendering are exactly S1's.
  const lines = body.split('\n');
  const ids = new Set();
  const toc = [];
  let excerpt = '';
  let seenPara = false;
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const bl = [];
      i++;
      while (i < n && !fenceClose(lines[i])) { bl.push(lines[i]); i++; }
      if (i < n) i++; // consume closing fence
      let s = '<pre><code' + (lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"') + '>';
      for (const l of bl) { s += escapeHtml(l); s += '\n'; }
      s += '</code></pre>\n';
      out.push(s);
      continue;
    }
    const hd = headingInfo(line);
    if (hd !== null) {
      const id = uniqueSlug(slugCached(slugCache, hd.text), ids);
      const html = inline(hd.text, linkFn);
      out.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>\n');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const ql = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimST(t);
        if (t !== '') ql.push(t);
        i++;
      }
      if (ql.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push('<blockquote>\n<p>' + inline(ql.join('\n'), linkFn) + '</p>\n</blockquote>\n');
      continue;
    }
    let bText = bulletInfo(line);
    let oInfo = null;
    let ordered = false;
    if (bText === null) { oInfo = orderedInfo(line); ordered = oInfo !== null; }
    if (bText !== null || oInfo !== null) {
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && oInfo.start !== 1 ? '<ol start="' + oInfo.start + '">' : '<' + tag + '>';
      let s = open + '\n';
      let parts = [trimST(ordered ? oInfo.text : bText)];
      i++;
      for (;;) {
        if (i >= n) { s += '<li>' + inline(parts.join('\n'), linkFn) + '</li>\n'; break; }
        const l = lines[i];
        let im = null;
        let oim = null;
        if (ordered) oim = orderedInfo(l);
        else im = bulletInfo(l);
        if (im !== null || oim !== null) {
          s += '<li>' + inline(parts.join('\n'), linkFn) + '</li>\n';
          parts = [trimST(ordered ? oim.text : im)];
          i++;
        } else if (isContinuation(l)) {
          parts.push(trimST(l));
          i++;
        } else {
          s += '<li>' + inline(parts.join('\n'), linkFn) + '</li>\n';
          break;
        }
      }
      s += '</' + tag + '>\n';
      out.push(s);
      continue;
    }
    // Paragraph: collect until blank, fence-open, heading, or thematic break.
    const pl = [];
    while (i < n) {
      const l = lines[i];
      if (isBlankLine(l)) break;
      if (fenceOpen(l) !== null) break;
      if (headingInfo(l) !== null) break;
      if (isHr(l)) break;
      pl.push(trimST(l));
      i++;
    }
    const html = inline(pl.join('\n'), linkFn);
    if (!seenPara) { excerpt = html; seenPara = true; }
    out.push('<p>' + html + '</p>\n');
  }
  return { html: out.join(''), toc, excerpt };
}

// ---- 7. Templates ----

function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    fail('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  }
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const c1 = src[open + 1];
    if (c1 !== '{' && c1 !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (c1 === '{') {
      const raw = src[open + 2] === '{';
      const closeMarker = raw ? '}}}' : '}}';
      const close = src.indexOf(closeMarker, open + (raw ? 3 : 2));
      if (close === -1) fail('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') { tokens.push({ kind: 'text', text }); text = ''; }
      const inner = src.slice(open + (raw ? 3 : 2), close).trim();
      tokens.push({ kind: raw ? 'raw' : 'var', path: pathOf(name, inner) });
      i = close + (raw ? 3 : 2);
    } else {
      const close = src.indexOf('%}', open + 2);
      if (close === -1) fail('template "' + name + '": a {% is not closed');
      const end = close + 2;
      const lineStart = src.lastIndexOf('\n', open - 1) + 1;
      const nl = src.indexOf('\n', end);
      const lineEnd = nl === -1 ? n : nl;
      const standalone = BLANK_RE.test(src.slice(lineStart, open)) && BLANK_RE.test(src.slice(end, lineEnd));
      if (standalone) text = text.slice(0, text.length - (open - lineStart));
      if (text !== '') { tokens.push({ kind: 'text', text }); text = ''; }
      tokens.push({ kind: 'tag', tag: src.slice(open + 2, close).trim() });
      i = standalone ? (nl === -1 ? n : nl + 1) : end;
    }
  }
  if (text !== '') tokens.push({ kind: 'text', text });
  return tokens;
}

function parentBody(node) {
  if (node.kind === 'root') return node.body;
  if (node.kind === 'for') return node.body;
  return node.else !== null ? node.else : node.then; // if
}

function parseTemplate(name, tokens) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokens) {
    if (tok.kind === 'text') { body.push({ kind: 'text', text: tok.text }); continue; }
    if (tok.kind === 'var' || tok.kind === 'raw') { body.push({ kind: tok.kind, path: tok.path }); continue; }
    const tag = tok.tag;
    let m;
    if ((m = FOR_RE.exec(tag))) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node); stack.push(node); body = node.body;
    } else if ((m = IF_RE.exec(tag))) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node); stack.push(node); body = node.then;
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top.kind !== 'if' || top.else !== null) fail('template "' + name + '": an else outside an if');
      top.else = []; body = top.else;
    } else if (tag === 'endfor') {
      const top = stack[stack.length - 1];
      if (top.kind !== 'for') fail('template "' + name + '": an endfor with no open for');
      stack.pop();
      body = parentBody(stack[stack.length - 1]);
    } else if (tag === 'endif') {
      const top = stack[stack.length - 1];
      if (top.kind !== 'if') fail('template "' + name + '": an endif with no open if');
      stack.pop();
      body = parentBody(stack[stack.length - 1]);
    } else if ((m = INCLUDE_RE.exec(tag))) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      fail('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) {
    fail('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  }
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  let v;
  let found = false;
  while (s) {
    if (Object.hasOwn(s.vars, path[0])) { v = s.vars[path[0]]; found = true; break; }
    s = s.parent;
  }
  if (!found) return undefined;
  for (let i = 1; i < path.length; i++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[i])) return undefined;
    v = v[path[i]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (const node of nodes) {
    if (node.kind === 'text') {
      out.push(node.text);
    } else if (node.kind === 'var') {
      out.push(escapeHtml(textOf(lookup(scope, node.path))));
    } else if (node.kind === 'raw') {
      out.push(textOf(lookup(scope, node.path)));
    } else if (node.kind === 'if') {
      const v = truthy(lookup(scope, node.path));
      const branch = (v !== node.not) ? node.then : node.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
    } else if (node.kind === 'for') {
      const xs = lookup(scope, node.path);
      if (Array.isArray(xs)) {
        const len = xs.length;
        // Reuse one vars/loop/scope object across iterations: rendering is
        // synchronous depth-first, and every body render follows a fresh
        // assignment of the loop variable and loop fields, so no iteration
        // can observe a stale value.
        const vars = {};
        const loop = { index: 1, first: true, last: len === 1, length: len };
        vars[node.name] = xs[0];
        vars.loop = loop;
        const childScope = { vars, parent: scope };
        for (let k = 0; k < len; k++) {
          if (k !== 0) {
            vars[node.name] = xs[k];
            loop.index = k + 1;
            loop.first = false;
            loop.last = k === len - 1;
          }
          renderNodes(node.body, childScope, ctx, depth, out);
        }
      }
    } else if (node.kind === 'include') {
      const t = ctx.templates.get(node.name);
      if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
    }
  }
}

// ---- run ----

export function run(input) {
  const report = [];
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources (sorted by path, code-unit order).
  const files = input.files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, content: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 2. Templates (parse first, in code-unit order of name).
  const templates = new Map();
  const tnames = Object.keys(input.templates).sort();
  for (const name of tnames) {
    try {
      templates.set(name, parseTemplate(name, tokenize(name, input.templates[name])));
    } catch (e) {
      report.push(e.message);
    }
  }

  // 3. Front matter + source checks, in sorted-path order.
  const kept = [];
  for (const src of sources) {
    let data, body;
    try {
      const fm = parseFrontMatter(src.content);
      data = fm.data; body = fm.body;
    } catch (e) {
      report.push('refused ' + src.path + ': ' + e.message);
      continue;
    }
    const isPost = src.path.startsWith('posts/');
    if (src.path.startsWith('tags/')) { report.push('refused ' + src.path + ": tags/ is the generator's own"); continue; }
    if (src.path.startsWith('page/')) { report.push('refused ' + src.path + ": page/ is the generator's own"); continue; }
    if (isPost && !Object.hasOwn(data, 'date')) { report.push('refused ' + src.path + ': a post needs a date'); continue; }
    const layout = Object.hasOwn(data, 'layout') ? data.layout : (isPost ? 'post' : 'page');
    if (!templates.has(layout)) { report.push('refused ' + src.path + ': layout "' + layout + '" is no template that parses'); continue; }
    if (data.draft === true) { report.push('draft ' + src.path); continue; }
    kept.push({ path: src.path, data, body, isPost, layout });
  }

  // Per-run caches (live and die inside this run() call only).
  const slugCache = new Map();
  const cardCache = new Map();

  // 4. Permalinks.
  const dirTaken = new Map();
  for (const k of kept) {
    const dir = k.isPost ? 'posts' : dirOf(k.path);
    let taken = dirTaken.get(dir);
    if (!taken) {
      taken = new Set();
      if (dir === '') { taken.add('posts'); taken.add('tags'); taken.add('page'); }
      dirTaken.set(dir, taken);
    }
    k.dir = dir;
    const baseSlug = Object.hasOwn(k.data, 'slug') ? k.data.slug : slugCached(slugCache, k.data.title);
    k.slug = uniqueSlug(baseSlug, taken);
    k.outPath = dir === '' ? k.slug + '/index.html' : dir + '/' + k.slug + '/index.html';
    k.url = dir === '' ? base + '/' + k.slug + '/' : base + '/' + dir + '/' + k.slug + '/';
  }

  // 5. Markdown + link resolution.
  const keptByPath = new Map();
  for (const k of kept) keptByPath.set(k.path, k);
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  const resolveLink = (target, srcDir, srcPath) => {
    if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35 || hasScheme(target)) return target;
    const hashIdx = target.indexOf('#');
    const rel = hashIdx === -1 ? target : target.slice(0, hashIdx);
    const frag = hashIdx === -1 ? '' : target.slice(hashIdx);
    let path = null;
    if (rel !== '') {
      const parts = srcDir === '' ? [] : srcDir.split('/');
      let ok = true;
      for (const seg of rel.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
          if (parts.length === 0) { ok = false; break; }
          parts.pop();
        } else parts.push(seg);
      }
      path = ok ? parts.join('/') : null;
    }
    if (path !== null) {
      const t = keptByPath.get(path);
      if (t) return t.url + frag;
      if (staticPaths.has(path)) return base + '/' + path + frag;
    }
    broken.add('broken-link ' + srcPath + ' -> ' + target);
    return target;
  };
  for (const k of kept) {
    // Link resolution starts from the source file's own directory
    // (e.g. posts/2018), not the permalink directory (posts).
    const r = renderMarkdown(k.body, (t) => resolveLink(t, dirOf(k.path), k.path), slugCache);
    k.content = r.html;
    k.toc = r.toc;
    k.excerpt = r.excerpt;
  }

  // 8. Collections, tags, cards, layouts.
  const posts = kept.filter((k) => k.isPost).sort((a, b) => {
    if (a.data.date > b.data.date) return -1;
    if (a.data.date < b.data.date) return 1;
    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;
    return 0;
  });
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i === 0 ? null : posts[i - 1];
    posts[i].older = i === posts.length - 1 ? null : posts[i + 1];
  }

  const ownTags = (k) => {
    const names = k.data.tags === undefined ? [] : k.data.tags;
    const seen = new Set();
    const out = [];
    for (const name of names) {
      const slug = slugCached(slugCache, name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };

  const tagBySlug = new Map();
  const allTags = [];
  for (const p of posts) {
    p.tagRefs = [];
    for (const t of ownTags(p)) {
      let tag = tagBySlug.get(t.slug);
      if (!tag) {
        tag = { name: t.name, slug: t.slug, url: base + '/tags/' + t.slug + '/', posts: [] };
        tagBySlug.set(t.slug, tag);
        allTags.push(tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const k of kept) {
    if (k.isPost) continue;
    k.tagRefs = ownTags(k).map((t) => {
      const tag = tagBySlug.get(t.slug);
      return tag !== undefined ? tag : { name: t.name, slug: t.slug, url: '', posts: [] };
    });
  }
  allTags.sort((a, b) => {
    if (a.posts.length !== b.posts.length) return b.posts.length - a.posts.length;
    if (a.slug < b.slug) return -1;
    if (a.slug > b.slug) return 1;
    return 0;
  });

  // One card per source per run: cardOf recomputes wordsOf(body) over the
  // whole body, so sharing it across index/tag/recent/page renders matters.
  // pageOf copies it (spread) before adding page-only fields.
  const cardOf = (k) => {
    let c = cardCache.get(k);
    if (c === undefined) {
      c = {
        title: k.data.title,
        url: k.url,
        date: k.data.date === undefined ? '' : k.data.date,
        date_long: k.data.date === undefined ? '' : longDate(k.data.date),
        summary: k.data.summary === undefined ? '' : k.data.summary,
        excerpt: k.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(k.body) / 200)),
        tags: k.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(k, c);
    }
    return c;
  };
  const linkCard = (p) => {
    if (p === null || p === undefined) return null;
    return {
      title: p.data.title,
      url: p.url,
      date: p.data.date === undefined ? '' : p.data.date,
      date_long: p.data.date === undefined ? '' : longDate(p.data.date),
    };
  };
  const pageOf = (k) => {
    const c = { ...cardOf(k) };
    c.slug = k.slug;
    c.content = k.content;
    c.toc = k.toc;
    c.newer = linkCard(k.newer === undefined ? null : k.newer);
    c.older = linkCard(k.older === undefined ? null : k.older);
    c.is_post = k.isPost;
    return c;
  };

  const siteVal = { title: input.site.title, base_url: base };
  const tagsVal = allTags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recentVal = posts.slice(0, input.site.recent).map(cardOf);

  const ctx = { templates, escape: escapeHtml };
  const render = (name, extra) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const vars = { site: siteVal, tags: tagsVal, recent: recentVal };
    for (const key of Object.keys(extra)) vars[key] = extra[key];
    const out = [];
    renderNodes(nodes, { vars, parent: null }, ctx, 0, out);
    return out.join('');
  };

  const output = {};
  for (const k of kept) {
    const html = render(k.layout, { page: pageOf(k) });
    if (html !== null) output[k.outPath] = html;
  }
  const perPage = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / perPage));
  const indexUrl = (kk) => (kk === 1 ? base + '/' : base + '/page/' + kk + '/');
  for (let kk = 1; kk <= pages; kk++) {
    const pagePosts = posts.slice((kk - 1) * perPage, kk * perPage).map(cardOf);
    const html = render('index', {
      posts: pagePosts,
      pager: {
        number: kk,
        total: pages,
        url: indexUrl(kk),
        newer_url: kk === 1 ? '' : indexUrl(kk - 1),
        older_url: kk === pages ? '' : indexUrl(kk + 1),
      },
    });
    if (html !== null) output[kk === 1 ? 'index.html' : 'page/' + kk + '/index.html'] = html;
  }
  for (const t of allTags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map(cardOf) },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  const lines = report.concat(Array.from(broken)).sort();
  lines.push('built ' + (kept.length - posts.length) + ' pages, ' + posts.length + ' posts, ' + allTags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
