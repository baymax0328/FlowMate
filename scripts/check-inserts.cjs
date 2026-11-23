// 精确核对 INSERT 的列数与值数（忽略字符串/括号内的逗号）
const fs = require('fs');
const files = process.argv.slice(2);
let bad = 0;
let total = 0;

function splitTop(s) {
  const out = [];
  let depth = 0;
  let q = null;
  let cur = '';
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const re = /INSERT INTO ([a-z_]+)\s*\(/g;
  let m;
  while ((m = re.exec(s))) {
    const table = m[1];
    // 取列清单
    let i = re.lastIndex;
    let depth = 1;
    let colsRaw = '';
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth++;
      if (ch === ')') { depth--; if (!depth) break; }
      colsRaw += ch;
    }
    // 之后找 VALUES(
    const rest = s.slice(i, i + 900);
    const vi = rest.search(/VALUES\s*\(/i);
    if (vi < 0) continue;
    let j = i + vi + rest.slice(vi).indexOf('(') + 1;
    let d2 = 1;
    let valsRaw = '';
    for (; j < s.length; j++) {
      const ch = s[j];
      if (ch === '(') d2++;
      if (ch === ')') { d2--; if (!d2) break; }
      valsRaw += ch;
    }
    const cols = splitTop(colsRaw);
    const vals = splitTop(valsRaw);
    total++;
    if (cols.length !== vals.length) {
      bad++;
      const line = s.slice(0, m.index).split('\n').length;
      console.log(`MISMATCH ${f}:${line}  表 ${table}  列 ${cols.length} 值 ${vals.length}`);
      console.log(`   值清单: ${valsRaw.slice(0, 200)}`);
    }
  }
}
console.log(`\n核对 ${total} 条 INSERT，不匹配 ${bad} 条`);
