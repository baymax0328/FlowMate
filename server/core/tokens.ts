// FlowMate · 中文二元组（bigram）分词与正文片段定位（PRD §15 / D2 的等价实现）
// 规格要求 PostgreSQL tsvector + 二元组策略；本版落地为 SQLite FTS5 + bigram 倒排（D1/D2 的等价替换，已记入覆盖矩阵）。

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;
const WORD = /[A-Za-z0-9_]+/;

/** 归一化：小写、压缩空白 */
export function normalize(s: string): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 切词：ASCII 词整词 + 连续汉字段做 1/2 元组。
 * 例：客户门户 → 客 户 门 户 客户 户门 门户
 * 单字也入索引，保证 1 字查询能命中。
 */
export function tokenize(s: string): string[] {
  const text = normalize(s);
  const out: string[] = [];
  const re = /[A-Za-z0-9_]+|[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = m[0];
    if (WORD.test(t)) {
      out.push(t);
      continue;
    }
    for (let i = 0; i < t.length; i++) {
      out.push(t[i]);
      if (i + 1 < t.length) out.push(t.slice(i, i + 2));
    }
  }
  return out;
}

export function tokensToIndex(s: string): string {
  const toks = tokenize(s);
  return toks.join(' ');
}

/** 把查询转成 FTS5 MATCH 表达式：每个 token 用引号包裹，AND 语义 */
export function buildMatch(query: string): string {
  const toks = Array.from(new Set(tokenize(query)));
  if (!toks.length) return '';
  return toks.map((t) => `"${t.replace(/"/g, '')}"`).join(' AND ');
}

export function hasQuery(query: string): boolean {
  return tokenize(query).length > 0;
}

/** 在原文中定位查询词，返回带命中标记的片段（服务正文检索结果展示，精确到字符） */
export function snippetFor(raw: string, query: string, radius = 90): { text: string; hits: [number, number][]; start: number } | null {
  const hay = normalize(raw);
  const q = normalize(query).trim();
  const hits: [number, number][] = [];
  if (!q) return null;
  let idx = hay.indexOf(q);
  const found: number[] = [];
  while (idx !== -1 && found.length < 20) {
    found.push(idx);
    idx = hay.indexOf(q, idx + Math.max(1, q.length));
  }
  if (!found.length) {
    // 单词命中：退化为逐 token 查找
    for (const t of Array.from(new Set(tokenize(q)))) {
      let i = hay.indexOf(t);
      while (i !== -1 && found.length < 20) {
        found.push(i);
        i = hay.indexOf(t, i + t.length);
      }
      if (found.length) break;
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => a - b);
  const first = found[0];
  const start = Math.max(0, first - radius);
  const end = Math.min(hay.length, first + radius + q.length);
  for (const f of found) {
    if (f >= start && f < end) hits.push([f - start, f - start + (q.length || 1)]);
  }
  return {
    text: (start > 0 ? '…' : '') + hay.slice(start, end) + (end < hay.length ? '…' : ''),
    hits,
    start,
  };
}

/** 行动项指纹（§14.3 去重键的一部分） */
export function fingerprint(s: string): string {
  const norm = normalize(s).replace(/[^\p{L}\p{N}]/gu, '');
  return norm.slice(0, 160);
}
