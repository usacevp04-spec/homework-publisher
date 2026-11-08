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
      executablePath:brave, headless:false, viewport:null,
      chromiumSandbox:true,
      args:['--no-first-run']
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
  const found=new Map();
  let unchanged=0, lastFingerprint='';
  report('Начинаю поиск ЦДЗ на открытой странице: '+page.url().split('?')[0]);
  try {
    for(let step=0;step<45 && !cancelScan;step++) {
      const data=await page.evaluate(() => {
        const re=/цдз/i;
        const nodes=[...document.querySelectorAll('p,li,td,span,div')];
        const hits=[];
        for(const el of nodes) {
          if(el.children.length && [...el.children].some(c=>re.test(c.innerText||''))) continue;
          const text=(el.innerText||'').trim().replace(/\s+/g,' ');
          if(text && re.test(text) && text.length<=400) hits.push(text);
        }
        const scrollables=[document.scrollingElement,...document.querySelectorAll('*')]
          .filter(Boolean).filter(el=>el.scrollHeight>el.clientHeight+80 && el.clientHeight>100);
        const target=scrollables.sort((a,b)=>(b.clientHeight*b.clientWidth)-(a.clientHeight*a.clientWidth))[0];
        const before=target?.scrollTop||0;
        const height=target?.scrollHeight||0;
        const viewport=target?.clientHeight||0;
        if(target) target.scrollTop=Math.min(target.scrollTop+Math.max(350,Math.floor(viewport*.8)),height);
        return {hits, before, after:target?.scrollTop||0,height,viewport};
      });
      for(const hit of data.hits) if(!found.has(hit)) {
        found.set(hit,true); report('ЦДЗ #'+found.size+': '+hit.slice(0,200));
      }
      const fingerprint=[data.after,data.height,found.size].join(':');
      if(fingerprint===lastFingerprint) unchanged++; else unchanged=0;
      lastFingerprint=fingerprint;
      if(step%5===0) report('Прокрутка '+(step+1)+': найдено '+found.size+' упоминаний ЦДЗ');
      if(unchanged>=3) break;
      await page.waitForTimeout(650);
    }
    if(cancelScan) report('Сканирование остановлено.');
    else report('Сканирование закончено. Уникальных текстовых упоминаний ЦДЗ: '+found.size+'. Это ещё не число завершённых тестов.');
    if(!found.size && !cancelScan) report('Проверь, что открыт именно раздел «Задания». Если список имеет отдельную прокрутку, потребуется уточнить его структуру.');
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
