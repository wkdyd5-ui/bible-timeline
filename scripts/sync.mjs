import {readFile,writeFile,rename,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const groups=[{id:'events',name:'주요 사건',color:'#AC701F'},{id:'judah',name:'통일왕국 · 남유다',color:'#2783DE'},{id:'israel',name:'북이스라엘',color:'#AF5575'},{id:'prophets',name:'선지자',color:'#30856C'},{id:'foreign',name:'주변 국가',color:'#8A6BBB'}];
const fields={'이름·사건':'title','분류':'select','시작 연도':'number','종료 연도':'number','연도 불확실':'checkbox','이름 굵게':'checkbox'};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validYear=x=>x===null||Number.isInteger(x)&&x!==0&&Math.abs(x)<=9999;
export function canonical(events){
 if(events.length>2000)throw Error('Maximum 2000 events exceeded');
 const result=events.map(e=>{
  if(typeof e.label!=='string'||!e.label.trim()||e.label.length>180)throw Error('Invalid event name');
  if(!groups.some(g=>g.id===e.group))throw Error('Unknown category');
  if(!validYear(e.start)||!validYear(e.end)||e.end!==null&&(e.start===null||e.end<e.start))throw Error('Invalid year values');
  return {group:e.group,label:e.label,start:e.start,end:e.end,approx:!!e.approx,bold:!!e.bold};
 }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
 const seen=new Map();return result.map(e=>{const key=hash(e).slice(0,18),n=seen.get(key)||0;seen.set(key,n+1);return {id:key+'-'+n,...e}});
}
export function fromPages(pages){return canonical(pages.filter(p=>!p.in_trash&&!p.archived&&!p.is_archived).map(p=>{
 if(p.object!=='page'||!p.properties)throw Error('Invalid page response');
 const props=p.properties;for(const [name,type]of Object.entries(fields))if(props[name]?.type!==type)throw Error('Required property missing or type changed: '+name);
 const category=groups.find(g=>g.name===props['분류'].select?.name);if(!category)throw Error('Missing or unknown category');
 return {label:props['이름·사건'].title.map(t=>t.plain_text??t.text?.content??'').join(''),group:category.id,start:props['시작 연도'].number,end:props['종료 연도'].number,approx:props['연도 불확실'].checkbox,bold:props['이름 굵게'].checkbox};
}));}
export function payload(events){return {version:1,title:'이스라엘 왕조 연대표',min:Math.min(-1020,...events.flatMap(e=>e.start===null?[]:[Math.floor(e.start/10)*10-10])),max:Math.max(-400,...events.flatMap(e=>e.start===null?[]:[Math.ceil((e.end??e.start)/10)*10+10])),scale:5,tick:50,groups,events,sourceName:'Notion 연대표 사건',sourceKind:'notion',sourceNotes:[]};}
export async function fetchEvents(token,fetcher=fetch){
 const url=new URL('https://api.notion.com/v1/data_sources/cc0402e4-6a40-44a8-9aa4-125290a0d0c1/query');
 for(const key of Object.keys(fields))url.searchParams.append('filter_properties',key);
 let cursor;const pages=[],seen=new Set();
 do{let response;
  for(let attempt=0;attempt<4;attempt++){
   response=await fetcher(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Notion-Version':'2025-09-03','Content-Type':'application/json'},body:JSON.stringify({page_size:100,...(cursor?{start_cursor:cursor}:{})}),signal:AbortSignal.timeout(45000)});
   if(response.ok)break;if(![429,500,502,503,504].includes(response.status)||attempt===3)throw Error('Notion request failed (HTTP '+response.status+'). Check connection access.');
   await new Promise(r=>setTimeout(r,Math.min(30000,Number(response.headers.get('retry-after')||2**attempt)*1000)));
  }
  const data=await response.json();
  if(!Array.isArray(data.results)||typeof data.has_more!=='boolean'||data.request_status?.type==='incomplete')throw Error('Incomplete Notion response; previous snapshot preserved');
  pages.push(...data.results);if(pages.length>2000)throw Error('Maximum 2000 events exceeded');
  cursor=data.has_more?data.next_cursor:null;if(data.has_more&&(!cursor||seen.has(cursor)))throw Error('Invalid pagination cursor');if(cursor)seen.add(cursor);
 }while(cursor);
 return fromPages(pages);
}
export async function run(){
 const file='site/data/timeline.json',old=JSON.parse(await readFile(file,'utf8'));let changed=false;
 if(!process.env.NOTION_TOKEN){console.log('::notice::NOTION_TOKEN is not configured. Publishing initial snapshot only; Notion sync is not active.');}
 else{
  const next=payload(await fetchEvents(process.env.NOTION_TOKEN)),fingerprint=hash(next);
  if(old.fingerprint!==fingerprint||old.syncConfigured!==true){
   const snapshot={...next,fingerprint,updatedAt:old.fingerprint===fingerprint?old.updatedAt:new Date().toISOString(),syncConfigured:true};
   await writeFile(file+'.tmp',JSON.stringify(snapshot,null,2)+'\n');await rename(file+'.tmp',file);changed=true;
  }
  console.log(changed?'Public timeline data changed.':'No public data change; deployment skipped.');
 }
 if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`changed=${changed}\n`);return changed;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)run().catch(error=>{const status=/HTTP (\d{3})/.exec(error.message)?.[1];const detail=status?'Notion API HTTP '+status:/^(Required property missing or type changed: |Missing or unknown category|Invalid year values|Invalid event name|Incomplete Notion response|Invalid pagination cursor|Maximum 2000 events exceeded)/.test(error.message)?error.message:'Network or response error';console.error('::error::'+detail+'. Previous snapshot is unchanged.');process.exitCode=1});
