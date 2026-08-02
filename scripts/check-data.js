const D = require('better-sqlite3');
const d = new D('./data/atlas.db');

// 检查各方向数据质量
const stats = d.prepare("SELECT direction, COUNT(*) as total, SUM(CASE WHEN title IS NULL OR title='' THEN 1 ELSE 0 END) as no_title, SUM(CASE WHEN citations > 1000 THEN 1 ELSE 0 END) as high_cite FROM papers GROUP BY direction").all();
console.log('=== Data Quality Check ===');
stats.forEach(s => console.log(`${s.direction.padEnd(15)} | total: ${String(s.total).padStart(3)} | no_title: ${s.no_title} | citations>1000: ${s.high_cite}`));

// 看 racing 方向 top 5
console.log('\n=== Racing Top 5 (by citations) ===');
const top5 = d.prepare("SELECT title, year, citations, venue FROM papers WHERE direction='racing' ORDER BY citations DESC LIMIT 5").all();
top5.forEach(p => console.log(`  [${p.citations}] ${p.year} | ${(p.title||'(no title)').substring(0,70)} | ${(p.venue||'').substring(0,30)}`));

// 检查与 driving/racing 无关的论文
console.log('\n=== Suspicious Papers (high-cite, non-driving) ===');
const suspicious = d.prepare(`
  SELECT direction, title, citations FROM papers 
  WHERE citations > 1000 
  AND (title IS NULL OR (
    title NOT LIKE '%driv%' AND title NOT LIKE '%rac%' AND title NOT LIKE '%vehicle%' 
    AND title NOT LIKE '%autonom%' AND title NOT LIKE '%robot%' AND title NOT LIKE '%car%'
    AND title NOT LIKE '%motion%' AND title NOT LIKE '%plan%' AND title NOT LIKE '%control%'
    AND title NOT LIKE '%percept%' AND title NOT LIKE '%detect%' AND title NOT LIKE '%learn%'
    AND title NOT LIKE '%neural%' AND title NOT LIKE '%model%' AND title NOT LIKE '%world%'
    AND title NOT LIKE '%simulat%' AND title NOT LIKE '%trajector%' AND title NOT LIKE '%sensor%'
    AND title NOT LIKE '%vision%' AND title NOT LIKE '%camera%' AND title NOT LIKE '%lidar%'
    AND title NOT LIKE '%point cloud%' AND title NOT LIKE '%end-to-end%' AND title NOT LIKE '%reinforc%'
  ))
  ORDER BY citations DESC LIMIT 10
`).all();
suspicious.forEach(p => console.log(`  [${p.direction}] [${p.citations}] ${(p.title||'(no title)').substring(0,70)}`));

d.close();
