import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const docPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'BACKEND_COMPLETE_ANALYSIS.md');
let t = fs.readFileSync(docPath, 'utf8');

// Remove duplicate title block before section 1
t = t.replace(
  /^---\r?\n# zztherapy Backend[^\n]+\r?\n\r?\n(?=## 1\.)/m,
  '---\n\n',
);

// Fix mojibake em dashes
t = t.replace(/\u00e2\u0080\u0094/g, '\u2014');
t = t.replace(/\u00e2\u20ac\u201c/g, '\u2014');
t = t.replace(/â€"/g, '\u2014');

// Normalize markdown links to repo-relative paths
t = t.replace(/\[([^\]]+)\]\(d:\\zztherapy\\backend\\([^)]+)\)/gi, '[$1](../$2)');
t = t.replace(/\[([^\]]+)\]\(d:\\zztherapy\\([^)]+)\)/gi, '[$1](../../$2)');
t = t.replace(/d:\\zztherapy\\backend\\/gi, '../');
t = t.replace(/d:\\zztherapy\\/gi, '../../');

fs.writeFileSync(docPath, t, 'utf8');
console.log('Fixed', docPath);
