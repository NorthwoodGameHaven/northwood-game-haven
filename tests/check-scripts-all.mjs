// NGH-BUILD 2026-09-11a
import vm from 'node:vm'; import fs from 'node:fs'; import path from 'node:path';
const root = process.argv[2] || 'site/app';
function walk(d){ return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{ const p=path.join(d,e.name); if(e.isSymbolicLink()) return []; return e.isDirectory()?walk(p):(p.endsWith('.html')?[p]:[]); }); }
let bad=0;
for (const f of walk(root)) {
  const h=fs.readFileSync(f,'utf8'); const re=/<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/g; let m,i=0;
  const closed = /<\/html>\s*$/i.test(h);
  while((m=re.exec(h))){ if(/type\s*=\s*["']?(application\/ld\+json|application\/json)/.test(m[1])) continue; i++; try{ new vm.Script(m[2],{filename:f}); }catch(e){ bad++; console.log('FAIL',f,e.message); } }
  console.log((closed?'ok  ':'NOEND'),f,'scripts:',i);
}
process.exit(bad?1:0);
