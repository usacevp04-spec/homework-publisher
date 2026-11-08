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
let context = null, running = false, stopping = false, exiting = false;
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
<button id="start">Начать проверку</button><button id="stop">Остановить</button><button id="exit">Выход</button>
<p id="status">Готов к запуску</p><pre id="log"></pre>
<small>Первая версия: только поиск упоминаний ЦДЗ на открытой странице. Никаких публикаций.</small>
<script>
const out=document.getElementById('log'),status=document.getElementById('status');
const stream=new EventSource('/events');
stream.onmessage=e=>{out.textContent+=JSON.parse(e.data)+'\n';out.scrollTop=out.scrollHeight};
async function act(name){try{const r=await fetch('/'+name,{method:'POST'});status.textContent=await r.text();if(name==='exit'){stream.close();window.close()}}catch(e){status.textContent='Приложение завершено'}}
document.getElementById('start').onclick=()=>act('start');
document.getElementById('stop').onclick=()=>act('stop');
document.getElementById('exit').onclick=()=>act('exit');
</script></html>`;
function send(res, code, value, type='text/plain; charset=utf-8') {
  res.writeHead(code, {'Content-Type':type, 'Cache-Control':'no-store'}); res.end(value);
}
async function stop() {
  if (stopping) return;
  stopping=true;
  try { if (context) await context.close(); } catch(e) { report('Закрытие браузера: '+e.message); }
  context=null; running=false; stopping=false; report('Проверка остановлена, окно Brave закрыто.');
}
async function scan() {
  if (running) return;
  running=true;
  report('Открываю Brave с отдельным профилем...');
  try {
    context=await chromium.launchPersistentContext(profile, {
      executablePath:brave, headless:false, viewport:null,
      args:['--no-first-run']
    });
    const page=context.pages()[0] || await context.newPage();
    await page.goto('https://school.mos.ru/diary/schedules/day', {waitUntil:'domcontentloaded',timeout:45000});
    report('Страница открыта: '+page.url().split('?')[0]);
    report('Проверяю видимый текст страницы...');
    await page.waitForTimeout(2500);
    const matches=await page.getByText(/ЦДЗ/i).allTextContents().catch(()=>[]);
    const unique=[...new Set(matches.map(s=>s.trim()).filter(Boolean))].slice(0,30);
    if(unique.length) unique.forEach((s,i)=>report((i+1)+'. '+s.slice(0,180)));
    else report('На текущей странице ЦДЗ не обнаружены. Это ещё не проверка всех дат и заданий.');
    report('Диагностика завершена. Brave остаётся открытым до нажатия «Остановить».');
  } catch(e) { report('Ошибка: '+e.message); await stop(); }
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
