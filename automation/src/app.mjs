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
  const assignments=new Map();
  report('Начинаю поиск ЦДЗ и цифровых заданий: '+page.url().split('?')[0]);
  try {
    // Use a stable element index only for this scan; re-identify scroll areas
    // each step because MES may rerender the list.
    const areas=await page.evaluate(() => {
      const elements=[document.scrollingElement,...document.querySelectorAll('*')].filter(Boolean);
      return elements.map((el,index)=>({el,index})).filter(({el})=>{
        const style=getComputedStyle(el);
        return el.scrollHeight>el.clientHeight+100 && el.clientHeight>140 &&
          (el===document.scrollingElement || /auto|scroll|overlay/.test(style.overflowY));
      }).map(({el,index})=>({
        index,tag:el.tagName,cls:String(el.className||'').slice(0,70),
        height:el.scrollHeight,view:el.clientHeight
      })).sort((a,b)=>b.height-a.height).slice(0,12);
    });
    report('Обнаружено прокручиваемых областей: '+areas.length);
    if(!areas.length) report('Прокручиваемые области не найдены. Открой раздел «Задания» и дождись загрузки.');

    for(let area=0;area<areas.length&&!cancelScan;area++) {
      const info=areas[area];
      report('Проверяю область '+(area+1)+'/'+areas.length+': '+info.tag+' '+info.cls);
      let stalled=0,lastPosition=-1,lastHeight=-1;
      for(let step=0;step<120&&!cancelScan;step++) {
        const result=await page.evaluate(({index,reset})=>{
          const all=[document.scrollingElement,...document.querySelectorAll('*')].filter(Boolean);
          const scroller=all[index];
          if(!scroller||!scroller.isConnected) return {missing:true,items:[]};
          if(reset) scroller.scrollTop=0;
          const normalize=value=>(value||'').replace(/\s+/g,' ').trim();
          const re=/цдз|цифров(?:ой|ого|ое|ые|ых|ым|ому|ыми)?\s+тест(?:а|ы|ов|ом|е|у|ами)?|цифров(?:ое|ого|ому|ым|ом|ые|ых|ыми)?\s+домашн(?:ее|его|ему|им|ем|ие|их|ими)?\s+задан(?:ие|ия|ию|ием|ии|ий|иями)?/i;
          const matches=[...document.querySelectorAll('p,li,td,span,div,a')]
            .filter(el=>{
              const t=normalize(el.innerText);
              return t.length>0&&t.length<450&&re.test(t)&&
                ![...el.children].some(child=>re.test(child.innerText||''));
            });
          const items=[];
          for(const node of matches) {
            // Prefer the smallest ancestor representing a full assignment,
            // not the entire subject/day group.
            let card=node;
            for(let depth=0;depth<6&&card.parentElement;depth++){
              const parent=card.parentElement;
              const t=normalize(parent.innerText);
              if(t.length>900||parent===document.body)break;
              card=parent;
              if(parent.querySelector('button,a,[role="button"]')&&t.length>normalize(node.innerText).length+12)break;
            }
            const cardText=normalize(card.innerText).slice(0,700);
            const title=normalize(node.innerText).slice(0,200);
            const groupText=normalize(card.parentElement?.innerText).slice(0,1000);
            const date=(cardText+' '+groupText).match(/\b(?:0?[1-9]|[12]\d|3[01])[./](?:0?[1-9]|1[012])(?:[./]\d{2,4})?\b/)?.[0]||'';
            const subject=(cardText+' '+groupText).match(/(?:алгебра|геометрия|математика|русский язык|литература|информатика|физика|химия|биология|история|обществознание|география|английский язык|иностранный язык)/i)?.[0]||'';
            const link=card.querySelector('a[href]')?.getAttribute('href')||node.closest('a[href]')?.getAttribute('href')||'';
            const id=card.getAttribute('data-id')||card.getAttribute('data-testid')||card.getAttribute('id')||'';
            const resultButton=/результат/i.test(cardText);
            // Element identity differentiates equal-looking cards in the
            // same rendered DOM; content differentiates recycled elements.
            if(!window.__hpCardIds) {window.__hpCardIds=new WeakMap();window.__hpNextCardId=1;}
            if(!window.__hpCardIds.has(card)) window.__hpCardIds.set(card,window.__hpNextCardId++);
            const domId=window.__hpCardIds.get(card);
            items.push({title,subject,date,link,id,domId,resultButton,cardText});
          }
          const before=scroller.scrollTop;
          const max=scroller.scrollHeight-scroller.clientHeight;
          scroller.scrollTop=Math.min(max,before+Math.max(250,Math.round(scroller.clientHeight*.7)));
          return {items,before,after:scroller.scrollTop,max,height:scroller.scrollHeight};
        },{index:info.index,reset:step===0});
        if(result.missing){report('Список перерисовался: область прокрутки изменилась.');break;}
        for(const item of result.items){
          // Distinguish cards with the same text by their actual DOM identity.
          // When a stable task ID or link exists, prefer that instead.
          const key=item.id?'id:'+item.id+'|'+item.title:
            item.link?'link:'+item.link+'|'+item.title:
            'dom:'+item.domId+'|'+item.title+'|'+item.cardText;
          if(assignments.has(key))continue;
          assignments.set(key,item);
          report('Карточка #'+assignments.size+
            ' | '+(item.subject||'предмет не определён')+
            ' | '+(item.date||'дата не определена')+
            ' | '+item.title+
            (item.resultButton?' | Есть надпись «Результат»':'')+
            ' | '+item.cardText.slice(0,130));
        }
        if(step%10===0)report('Прокрутка '+(area+1)+': '+Math.round(result.after)+'/'+Math.round(result.max)+' px; карточек '+assignments.size);
        if(result.after===lastPosition&&result.height===lastHeight&&result.after>=result.max-2)stalled++;else stalled=0;
        lastPosition=result.after;lastHeight=result.height;
        if(stalled>=5)break;
        await page.waitForTimeout(500);
      }
    }
    if(cancelScan)report('Сканирование остановлено.');
    else report('Готово: '+assignments.size+' предварительно различённых карточек ЦДЗ/цифровых заданий. Совпадения названий не объединялись. Для точного учёта требуется проверить структуру карточек МЭШ.');
  } catch(e){if(!cancelScan)report('Ошибка сканирования: '+e.message);}
  finally{scanning=false;}
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
