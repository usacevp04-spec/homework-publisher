import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright';

const profile = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'HomeworkPunisher', 'BraveProfile');
const bravePaths = [
  join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
];
const brave = bravePaths.find(existsSync);
if (!brave) { console.error('Brave не найден. Установите Brave Browser.'); process.exit(1); }
let context = null, running = false, scanning = false, stopping = false, exiting = false;
let managedPage = null;
let cancelScan = false;
const log = [];
const clients = new Set();
function report(message) {
  const entry = new Date().toLocaleTimeString('ru-RU') + '  ' + message;
  log.push(entry); if (log.length > 200) log.shift();
  for (const res of clients) { try { res.write('data: ' + JSON.stringify(entry) + '\n\n'); } catch {} }
  console.log(entry);
}
const html = String.raw`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Homework Punisher</title>
<style>body{font:16px system-ui;background:#111827;color:#f9fafb;max-width:780px;margin:50px auto;padding:0 20px}button{border:0;border-radius:9px;padding:13px 20px;margin:0 8px 16px 0;cursor:pointer;font-weight:600}button:disabled{opacity:.4}#start{background:#86efac}#stop{background:#fde68a}#exit{background:#fca5a5}pre{background:#030712;border-radius:12px;padding:18px;height:340px;overflow:auto;white-space:pre-wrap}small{color:#9ca3af}</style>
<h1>Homework Punisher</h1><p>Локальная проверка МЭШ через отдельный профиль Brave</p>
<button id="start">Открыть Brave</button><button id="scan">Сканировать страницу</button><button id="stop">Остановить</button><button id="exit">Выход</button>
<p id="status">Готов к запуску</p><pre id="log"></pre>
<small>Открой раздел «Задания» в Brave, затем нажми «Сканировать страницу». Результаты тестов не открываются, публикаций нет.</small>
<script>
const out=document.getElementById('log'),status=document.getElementById('status');
const stream=new EventSource('/events');
stream.onmessage=e=>{out.textContent+=JSON.parse(e.data)+'\n';out.scrollTop=out.scrollHeight};
async function act(name){try{const r=await fetch('/'+name,{method:'POST'});status.textContent=await r.text();if(name==='exit'){stream.close();window.close()}}catch(e){status.textContent='Приложение завершено'}}
document.getElementById('start').onclick=()=>act('start');
document.getElementById('scan').onclick=()=>act('scan');
document.getElementById('stop').onclick=()=>act('stop');
document.getElementById('exit').onclick=()=>act('exit');
</script></html>`;
function send(res, code, value, type='text/plain; charset=utf-8') {
  res.writeHead(code, {'Content-Type':type, 'Cache-Control':'no-store'}); res.end(value);
}
async function stop() {
  if (stopping) return;
  stopping=true;
  cancelScan=true;
  try { if (context) await context.close(); } catch(e) { report('Закрытие браузера: '+e.message); }
  context=null; managedPage=null; running=false; scanning=false; stopping=false; report('Проверка остановлена, окно Brave закрыто.');
}
async function scan() {
  if (running) return;
  running=true;
  report('Открываю Brave с отдельным профилем...');
  try {
    context=await chromium.launchPersistentContext(profile, {
      executablePath:brave,
      headless:false,
      viewport:null,
      chromiumSandbox:true,
      ignoreDefaultArgs: ['--enable-automation'],
      args:[
        '--no-first-run',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    // Persistent Brave profiles can restore an existing MES tab and a blank tab.
    // Reuse the MES tab, or the initial blank tab, instead of opening another.
    const pages = context.pages();
    const page = pages.find(p => p.url().startsWith('https://school.mos.ru/'))
      || pages.find(p => p.url() === 'about:blank')
      || pages[0]
      || await context.newPage();
    if (!page.url().startsWith('https://school.mos.ru/diary/schedules/day')) {
      await page.goto('https://school.mos.ru/diary/schedules/day', {waitUntil:'domcontentloaded',timeout:45000});
    }
    // Close only spare blank tabs created/restored in this managed browser.
    for (const spare of context.pages()) {
      if (spare !== page && spare.url() === 'about:blank') {
        await spare.close().catch(() => {});
      }
    }
    managedPage=page;
    report('Страница открыта: '+page.url().split('?')[0]);
    report('Перейди в Brave в раздел «Задания», затем нажми «Сканировать страницу».');
  } catch(e) { report('Ошибка: '+e.message); await stop(); }
}

async function scanVisibleAssignments() {
  if (scanning || !managedPage || managedPage.isClosed()) return;
  scanning=true; cancelScan=false;
  const page=managedPage;
  const seen=new Set();
  let total=0;
  report('Начинаю расширенный поиск ЦДЗ: '+page.url().split('?')[0]);
  try {
    // Traverse each scrollable container independently: the homework list may
    // scroll inside a nested element instead of the document.
    const candidates=await page.evaluate(() => {
      const all=[document.scrollingElement,...document.querySelectorAll('*')].filter(Boolean);
      return all.map((el,i)=>({i,el})).filter(({el})=>{
        const style=getComputedStyle(el);
        return el.scrollHeight>el.clientHeight+100 && el.clientHeight>140 &&
          (el===document.scrollingElement || /auto|scroll|overlay/.test(style.overflowY));
      }).map(({i,el})=>({
        index:i, tag:el.tagName, cls:String(el.className||'').slice(0,70),
        height:el.scrollHeight, view:el.clientHeight
      })).sort((a,b)=>b.height-a.height).slice(0,12);
    });
    report('Прокручиваемых областей: '+candidates.length);
    if(!candidates.length) report('Не обнаружены прокручиваемые области. Возможно, список ещё загружается.');
    for(let area=0;area<candidates.length && !cancelScan;area++){
      const info=candidates[area];
      report('Область '+(area+1)+'/'+candidates.length+': '+info.tag+' '+info.cls+' ('+info.view+'/'+info.height+' px)');
      let stalled=0, lastPosition=-1;
      for(let step=0;step<120 && !cancelScan;step++){
        const result=await page.evaluate(({index,reset})=>{
          const all=[document.scrollingElement,...document.querySelectorAll('*')].filter(Boolean);
          const el=all[index];
          if(!el || !el.isConnected) return {missing:true,hits:[]};
          if(reset) el.scrollTop=0;
          const re=/цдз/i;
          const hits=[];
          for(const node of document.querySelectorAll('p,li,td,span,div')){
            if(node.children.length && [...node.children].some(child=>re.test(child.innerText||''))) continue;
            const value=(node.innerText||'').trim().replace(/\s+/g,' ');
            if(!value || !re.test(value) || value.length>400) continue;
            const parent=node.parentElement;
            const context=(parent?.parentElement?.innerText||parent?.innerText||value)
              .trim().replace(/\s+/g,' ').slice(0,500);
            const rect=node.getBoundingClientRect();
            // Deduplicate nested representations but retain equal texts in
            // distinct visible homework cards.
            hits.push({value,context,y:Math.round(rect.top)});
          }
          const before=el.scrollTop;
          const max=el.scrollHeight-el.clientHeight;
          el.scrollTop=Math.min(max,before+Math.max(250,Math.round(el.clientHeight*.7)));
          return {hits,before,after:el.scrollTop,max,scrollHeight:el.scrollHeight};
        },{index:info.index,reset:step===0});
        if(result.missing){report('Область изменилась при загрузке; пропускаю.');break;}
        for(const hit of result.hits){
          // Context helps distinguish identical labels across assignments.
          const key=hit.value+'|'+hit.context;
          if(!seen.has(key)){
            seen.add(key);total++;
            report('ЦДЗ #'+total+': '+hit.value.slice(0,140)+' | Контекст: '+hit.context.slice(0,160));
          }
        }
        if(step%10===0) report('Область '+(area+1)+', шаг '+(step+1)+': '+Math.round(result.after)+'/'+Math.round(result.max)+' px, найдено '+total);
        if(result.after===lastPosition && result.after>=result.max-2) stalled++; else stalled=0;
        lastPosition=result.after;
        if(stalled>=5) break;
        await page.waitForTimeout(500);
      }
    }
    if(cancelScan) report('Сканирование остановлено.');
    else report('Поиск завершён. Найдено '+total+' различных сочетаний текста и контекста ЦДЗ. Это предварительный результат, не число тестов.');
  } catch(e) { if(!cancelScan) report('Ошибка сканирования: '+e.message); }
  finally { scanning=false; }
}

const server=http.createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(req.method==='GET'&&path==='/') return send(res,200,html,'text/html; charset=utf-8');
  if(req.method==='GET'&&path==='/events'){
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive'});
    clients.add(res); for(const item of log)res.write('data: '+JSON.stringify(item)+'\n\n');
    req.on('close',()=>clients.delete(res)); return;
  }
  if(req.method==='POST'&&path==='/start'){
    if(running||stopping) return send(res,409,'Проверка уже запущена');
    void scan(); return send(res,200,'Проверка запущена');
  }
  if(req.method==='POST'&&path==='/scan'){
    if(!running || !managedPage || managedPage.isClosed()) return send(res,409,'Сначала открой Brave');
    if(scanning) return send(res,409,'Сканирование уже выполняется');
    void scanVisibleAssignments(); return send(res,200,'Сканирование запущено');
  }
  if(req.method==='POST'&&path==='/stop'){
    void stop(); return send(res,200,'Останавливаю...');
  }
  if(req.method==='POST'&&path==='/exit'){
    if(exiting)return send(res,200,'Завершение...');
    exiting=true; send(res,200,'Программа завершается');
    await stop(); server.close(()=>process.exit(0));
    for(const c of clients)c.end();
    return;
  }
  send(res,404,'Не найдено');
});
server.listen(0,'127.0.0.1',()=>{
  const address=server.address();
  const url='http://127.0.0.1:'+address.port;
  report('Панель управления: '+url);
  spawn('cmd.exe',['/c','start','',url],{stdio:'ignore',windowsHide:true});
});
process.on('SIGINT',async()=>{await stop();process.exit(0)});
process.on('SIGTERM',async()=>{await stop();process.exit(0)});
