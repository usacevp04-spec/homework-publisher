// Offline parser for user-saved MES result HTML. Never executes scripts or loads remote resources.
function clean(s) { return s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim(); }
export function parseResultHtml(html) {
  const title = html.match(/PlayerDescriptionBlock-title[^>]*>([^<]*)</)?.[1] || '';
  const number = Number(title.match(/Задание\s*(\d+)/i)?.[1]);
  if (!number) throw new Error('Не найден номер открытого задания. Открой результат ЦДЗ и сохрани страницу.');
  const questionSection=html.match(/data-testid="textElementEditor"[\s\S]*?<\/div><\/div><\/div><\/div><\/div><\/div>/)?.[0] || '';
  const question=[...questionSection.matchAll(/<span data-text="true">([\s\S]*?)<\/span>/g)].map(m=>clean(m[1])).join(' ');
  const body=html.split('PlayerPage-testBody')[1] || '';
  const input=body.match(/<input\b[^>]*\bvalue="([^"]*)"[^>]*>/)?.[1];
  const correct=/Ваш ответ верный/.test(body);
  const incorrect=/Ваш ответ неверный/.test(body);
  const total=Number(html.match(/PlayerResultHeaderTop-scoreValue[^>]*>(\d+)</)?.[1]);
  const max=Number(html.match(/PlayerResultHeaderTop-scoreValue[^>]*>\d+<\/h2>\s*\/\s*(\d+)/)?.[1]);
  const count=(html.match(/PlayerNavigationButton-groupedButton/g)||[]).length;
  return {number,question,answer:input===undefined?null:clean(input),status:correct?'correct':incorrect?'incorrect':'unknown',score:Number.isFinite(total)?total:null,maxScore:Number.isFinite(max)?max:null,taskCount:count||null};
}
export function formatSummary(items){
  const ordered=[...items].sort((a,b)=>a.number-b.number);
  return ['📚 Результаты ЦДЗ','',...ordered.map(x=>`${x.number}. ${x.answer ?? 'Ответ не извлечён'}${x.status==='correct'?' ✅':''}`)].join('\n');
}
