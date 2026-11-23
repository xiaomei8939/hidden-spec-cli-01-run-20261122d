// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
// In a trial the grader runs this file with MAKEFUN_ENV_URL set; the last
// lines then hand over to runner.ts, exactly as the kit requires.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

// Patch lines: split at \n, one trailing \r removed, no empty piece after a final \n.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function needSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

// A file split into lines: its own line break, its lines, whether it ends with one.
interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}
function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}
function joinFile(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk.
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

// ---- Section 5: matching lines at three tiers ----

function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Positions (>= from) where O occurs, at the first tier that has any. Null when no tier has one.
function findTier(lines: string[], o: string[], strict: boolean, from: number, onlyEof: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = o.map((l) => tierLine(l, tier));
    const positions: number[] = [];
    for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
      if (onlyEof && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (tierLine(lines[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// Build the replacement lines: context lines come from the file itself; at tier 2 the
// other lines are re-indented from O's first line's prefix to the file line's prefix.
function buildNew(lines: string[], pos: number, o: string[], n: string[], ctx: Map<number, number>, tier: number): string[] {
  let leadF = '';
  let leadP = '';
  if (tier === 2 && o.length > 0) {
    leadF = /^[ \t]*/.exec(lines[pos] ?? '')![0];
    leadP = /^[ \t]*/.exec(o[0]!)![0];
  }
  const out: string[] = [];
  for (let j = 0; j < n.length; j += 1) {
    const ci = ctx.get(j);
    if (ci !== undefined) {
      out.push(lines[pos + ci]!);
      continue;
    }
    let s = n[j]!;
    if (tier === 2 && s.trim() !== '' && s.startsWith(leadP)) s = leadF + s.slice(leadP.length);
    out.push(s);
  }
  return out;
}

// Replace O at the found tier, using the chooser to pick among positions.
function replaceFound(
  parts: FileParts,
  o: string[],
  n: string[],
  ctx: Map<number, number>,
  strict: boolean,
  from: number,
  onlyEof: boolean,
  choose: (positions: number[]) => number,
  failPath: string,
): { pos: number; tier: number } {
  const found = findTier(parts.lines, o, strict, from, onlyEof);
  if (found === null) throw new Fail('no-match', failPath);
  const pos = choose(found.positions);
  const built = buildNew(parts.lines, pos, o, n, ctx, found.tier);
  parts.lines.splice(pos, o.length, ...built);
  return { pos, tier: found.tier };
}

// ---- Section 4: format detection ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 6: unified diffs ----

interface HunkItem {
  kind: string; // ' ', '-', '+', '\\'
  text: string;
  rawEmpty: boolean;
  noEol: boolean;
}
interface Hunk {
  a: number;
  items: HunkItem[];
}
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hasHunk: boolean;
  hunks: Hunk[];
}
function newSection(): Section {
  return { gitOld: null, gitNew: null, pairOld: null, pairNew: null, hasPair: false, renFrom: null, renTo: null, newFile: false, delFile: false, hasHunk: false, hunks: [] };
}
function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p !== '/dev/null' && (p.startsWith('a/') || p.startsWith('b/'))) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.+) b\/(.+)$/.exec(line.slice('diff --git '.length));
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !cur.hasPair && !cur.hasHunk) {
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
      } else {
        cur = newSection();
        cur.pairOld = headerPath(line.slice(4));
        cur.pairNew = headerPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && !cur.hasHunk) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s.*)?$/.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), items: [] };
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          hunk.items.push({ kind: ' ', text: '', rawEmpty: true, noEol: false });
          j += 1;
        } else if (bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          hunk.items.push({ kind: bl[0]!, text: bl.slice(1), rawEmpty: false, noEol: false });
          j += 1;
        } else if (bl[0] === '\\') {
          hunk.items.push({ kind: '\\', text: bl, rawEmpty: false, noEol: false });
          j += 1;
        } else break;
      }
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === ' ' && last.rawEmpty) hunk.items.pop();
        else break;
      }
      // A `\` line marks the body line before it.
      for (let k = 0; k < hunk.items.length; k += 1) {
        if (hunk.items[k]!.kind === '\\' && k > 0) hunk.items[k - 1]!.noEol = true;
      }
      cur.hunks.push(hunk);
      cur.hasHunk = true;
      i = j;
      continue;
    }
    if (cur !== null && !cur.hasHunk) {
      if (line.startsWith('rename from ')) cur.renFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function hunkON(hunk: Hunk): { o: string[]; n: string[]; ctx: Map<number, number> } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx = new Map<number, number>();
  for (const it of hunk.items) {
    if (it.kind === ' ') {
      ctx.set(n.length, o.length);
      o.push(it.text);
      n.push(it.text);
    } else if (it.kind === '-') o.push(it.text);
    else if (it.kind === '+') n.push(it.text);
  }
  return { o, n, ctx };
}

// Whether a `\` line follows the hunk's last context or `+` line.
function hunkLastNoEol(hunk: Hunk): boolean {
  for (let k = hunk.items.length - 1; k >= 0; k -= 1) {
    const it = hunk.items[k]!;
    if (it.kind === ' ' || it.kind === '+') return it.noEol;
    if (it.kind === '-') return false;
  }
  return false;
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (s.hasPair) {
    oldP = s.pairOld;
    newP = s.pairNew;
  } else if (s.renFrom !== null || s.renTo !== null) {
    oldP = s.renFrom;
    newP = s.renTo;
  } else {
    oldP = s.gitOld;
    newP = s.gitNew;
  }
  const isCreate = s.newFile || oldP === '/dev/null';
  const isDelete = s.delFile || newP === '/dev/null';
  return (tree) => {
    if (isCreate) {
      const target = newP !== null && newP !== '/dev/null' ? newP : oldP!;
      needSafe(target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const out: string[] = [];
      let lastPlusNoEol = false;
      for (const h of s.hunks) {
        for (const it of h.items) {
          if (it.kind === '+') {
            out.push(it.text);
            lastPlusNoEol = it.noEol;
          }
        }
      }
      tree.set(target, out.length === 0 ? '' : out.join('\n') + (lastPlusNoEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldP !== null && oldP !== '/dev/null' ? oldP : newP!;
      needSafe(target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.set(target, null);
      return;
    }
    const from = oldP!;
    const to = newP !== null ? newP : oldP!;
    const isMove = from !== to;
    needSafe(from);
    if (isMove) needSafe(to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (isMove && tree.get(to) !== null) throw new Fail('exists', to);
    const parts = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const { o, n, ctx } = hunkON(h);
      if (o.length === 0) {
        const atEnd = parts.lines.length <= Math.max(0, h.a + d);
        const pos = Math.min(Math.max(0, h.a + d), parts.lines.length);
        parts.lines.splice(pos, 0, ...n);
        if (atEnd && n.length > 0) parts.final = !hunkLastNoEol(h);
      } else {
        const target = h.a - 1 + d;
        const found = findTier(parts.lines, o, strict, 0, false);
        if (found === null) throw new Fail('no-match', from);
        let best = found.positions[0]!;
        for (const p of found.positions) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const runsToEnd = best + o.length === parts.lines.length;
        const built = buildNew(parts.lines, best, o, n, ctx, found.tier);
        parts.lines.splice(best, o.length, ...built);
        if (runsToEnd) parts.final = !hunkLastNoEol(h);
      }
      d += n.length - o.length;
    }
    const text = joinFile(parts.br, parts.lines, parts.final);
    if (isMove) {
      tree.set(to, text);
      tree.set(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.set(from, text);
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldL: string[];
    newL: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= scanFrom; k -= 1) {
      const cand = lines[k]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path: path!, oldL: lines.slice(i + 1, eq), newL: lines.slice(eq + 1, rep) });
    prevPath = path;
    scanFrom = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    needSafe(b.path);
    if (b.oldL.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.set(b.path, b.newL.length === 0 ? '' : b.newL.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const parts = splitFile(before);
    const found = findTier(parts.lines, b.oldL, strict, 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const built = buildNew(parts.lines, found.positions[0]!, b.oldL, b.newL, new Map(), found.tier);
    parts.lines.splice(found.positions[0]!, b.oldL.length, ...built);
    tree.set(b.path, joinFile(parts.br, parts.lines, parts.final));
  });
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: Array<{ kind: string; text: string }>;
}
interface VSection {
  kind: string; // 'add' | 'delete' | 'update'
  path: string;
  line: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const heads: Array<{ idx: number; kind: string; path: string }> = [];
  for (let k = first + 1; k < last; k += 1) {
    const l = lines[k]!;
    if (l.startsWith('*** Add File: ')) heads.push({ idx: k, kind: 'add', path: l.slice('*** Add File: '.length).trim() });
    else if (l.startsWith('*** Delete File: ')) heads.push({ idx: k, kind: 'delete', path: l.slice('*** Delete File: '.length).trim() });
    else if (l.startsWith('*** Update File: ')) heads.push({ idx: k, kind: 'update', path: l.slice('*** Update File: '.length).trim() });
  }
  // Any non-blank line before the first section head is a parse error; blank lines
  // (empty or only whitespace) between sections are ignored, here and throughout.
  const firstHead = heads.length > 0 ? heads[0]!.idx : last;
  for (let k = first + 1; k < firstHead; k += 1) {
    if (!blank(lines[k]!)) throw new Exit2(`error: parse ${k + 1}`);
  }
  const sections: VSection[] = [];
  for (let h = 0; h < heads.length; h += 1) {
    const head = heads[h]!;
    const end = h + 1 < heads.length ? heads[h + 1]!.idx : last;
    const raw: Array<{ idx: number; text: string }> = [];
    for (let k = head.idx + 1; k < end; k += 1) raw.push({ idx: k, text: lines[k]! });
    // Blank lines at the end of a section are not part of it: a line that is empty or
    // only whitespace (such as a lone-space context line) is dropped from the tail.
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    const sec: VSection = { kind: head.kind, path: head.path, line: head.idx + 1, addLines: [], moveTo: null, chunks: [] };
    if (head.kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
    } else if (head.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
    } else {
      let pos = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        pos = 1;
      }
      let chunk: VChunk | null = null;
      for (let k = pos; k < raw.length; k += 1) {
        const r = raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          chunk = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), eof: false, items: [] };
          sec.chunks.push(chunk);
        } else if (t === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, items: [] };
            sec.chunks.push(chunk);
          } else chunk.eof = true;
          chunk = null;
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, items: [] };
            sec.chunks.push(chunk);
          }
          chunk.items.push({ kind: t === '' ? ' ' : t[0]!, text: t === '' ? '' : t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.idx + 1}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.line}`);
    }
    sections.push(sec);
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function v4aSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    needSafe(s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.set(s.path, null);
      return;
    }
    if (s.moveTo !== null) needSafe(s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const parts = splitFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          const want = tierLine(chunk.anchor, tier);
          for (let k = cursor; k < parts.lines.length; k += 1) {
            if (tierLine(parts.lines[k]!, tier) === want) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const o: string[] = [];
      const n: string[] = [];
      const ctx = new Map<number, number>();
      for (const it of chunk.items) {
        if (it.kind === ' ') {
          ctx.set(n.length, o.length);
          o.push(it.text);
          n.push(it.text);
        } else if (it.kind === '-') o.push(it.text);
        else n.push(it.text);
      }
      if (o.length === 0) {
        const pos = chunk.eof ? parts.lines.length : Math.min(cursor, parts.lines.length);
        parts.lines.splice(pos, 0, ...n);
        cursor = pos + n.length;
      } else {
        const found = findTier(parts.lines, o, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', s.path);
        const pos = found.positions[0]!;
        const built = buildNew(parts.lines, pos, o, n, ctx, found.tier);
        parts.lines.splice(pos, o.length, ...built);
        cursor = pos + built.length;
      }
    }
    const text = joinFile(parts.br, parts.lines, parts.final);
    if (s.moveTo !== null) {
      tree.set(s.moveTo, text);
      tree.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.set(s.path, text);
    }
  };
}

// ---- Section 9: JSON edits ----

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    needSafe(p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const parts = splitFile(before);
      const crlf = parts.br === '\r\n' && before !== '';
      const lf = (x: string): string => (crlf ? x.replaceAll('\r\n', '\n') : x);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const parts = splitFile(before);
      if (line < 0 || line > parts.lines.length) throw new Fail('no-match', p);
      parts.lines.splice(line, 0, ...add);
      tree.set(p, joinFile(parts.br, parts.lines, parts.final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Sections 1, 2 and 10: the command line, output and atomicity ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
    text = '';
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // Changed paths, with qualifying moves shown as one R line sorted by the new path.
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const suppressed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  const seenMove = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const tag = `${oldP}\n${newP}`;
    if (seenMove.has(tag)) continue;
    seenMove.add(tag);
    if (tree.original(oldP) === null) continue;
    if (tree.get(oldP) !== null) continue;
    if (tree.original(newP) !== null) continue;
    if (tree.get(newP) === null) continue;
    suppressed.add(oldP);
    suppressed.add(newP);
    rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  }
  for (const p of changed) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
