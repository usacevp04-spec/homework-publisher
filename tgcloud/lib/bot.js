import { api } from 'sdk';
import { config } from './config.js';
import { authorized, channelConfigured, parseDate, validDraft } from './model.js';
import { ensure, load, save, record, finish } from './store.js';
import { say, show, media } from './ui.js';

export async function publish(draft) {
  if (draft.state !== 'preview') return show(draft);
  if (!channelConfigured(config)) return say(draft.userId, 'Канал не настроен. Обратитесь к администратору.');
  if (!validDraft(draft.data, config)) return say(draft.userId, 'Проверьте дату, поля и фотографии. Публикация отклонена.');
  // The CAS is before every Telegram send. Never unlock an ambiguous send.
  const locked = await save(draft, 'publishing', draft.data);
  if (!locked) return say(draft.userId, 'Состояние изменилось. Используйте /draft.');
  const id = `${draft.userId}:${locked.revision}`;
  let sent;
  try {
    await record(id, locked, config.channelId);
    sent = await media(config.channelId, locked.data);
    if (!Array.isArray(sent) || sent.length !== locked.data.photos.length || sent.some(m => !Number.isSafeInteger(m.message_id))) {
      throw new Error('Unexpected Telegram response');
    }
    await finish(id, 'published', sent.map(m => m.message_id));
    const done = await save(locked, 'published', locked.data);
    if (!done) throw new Error('Publication state changed');
  } catch (error) {
    console.error('Publication requires manual reconciliation', id, error);
    // Even a known API rejection is kept locked: no automatic resend policy.
    try { await finish(id, 'uncertain', sent?.map(m => m.message_id) || []); } catch (e) { console.error('Audit update failed', id, e); }
    try { await save(locked, 'uncertain', locked.data); } catch (e) { console.error('Draft update failed', id, e); }
    return say(draft.userId, `Результат публикации ${id} требует проверки канала администратором. Повторная отправка заблокирована.`);
  }
  // Notification failure must never turn a successful send into a retry.
  return show(await load(draft.userId));
}

export async function onCallback(query) {
  const chat = query.message?.chat;
  if (!authorized(query.from, chat, config)) {
    await api.answerCallbackQuery({ callback_query_id: query.id, text: 'Доступ запрещён.', show_alert: true });
    return;
  }
  await api.answerCallbackQuery({ callback_query_id: query.id });
  const match = /^hw:(\d+):([a-z]+(?:_\d+)?)$/.exec(query.data || '');
  const draft = await ensure(query.from.id);
  if (!match || Number(match[1]) !== draft.revision) return say(chat.id, 'Кнопка устарела. Откройте /draft.');
  if (['publishing', 'uncertain'].includes(draft.state)) return show(draft);
  const action = match[2];
  let state, data = { ...draft.data };
  if (action === 'new' && ['empty', 'cancelled', 'published'].includes(draft.state)) {
    state = 'type'; data = { photos: [] };
  } else if (action === 'cancel' && ['type', 'date', 'subject', 'title', 'photos', 'preview'].includes(draft.state)) {
    state = 'cancelled'; data = {};
  } else if (draft.state === 'type' && /^type_\d+$/.test(action) && config.types[Number(action.slice(5))]) {
    state = 'date'; data.type = config.types[Number(action.slice(5))];
  } else if (draft.state === 'subject' && /^subject_\d+$/.test(action) && config.subjects[Number(action.slice(8))]) {
    state = 'title'; data.subject = config.subjects[Number(action.slice(8))];
  } else if (draft.state === 'photos' && action === 'clear') {
    state = 'photos'; data.photos = [];
  } else if (draft.state === 'photos' && action === 'preview') {
    if (!validDraft(data, config)) return say(chat.id, 'Нужны корректные поля, актуальная дата и от 1 до 10 фотографий.');
    state = 'preview';
  } else if (draft.state === 'preview' && action === 'edit') {
    state = 'photos';
  } else if (draft.state === 'preview' && action === 'publish') {
    return publish(draft);
  } else return say(chat.id, 'Действие недоступно. Откройте /draft.');
  const next = await save(draft, state, data);
  return next ? show(next) : say(chat.id, 'Черновик изменился. Откройте /draft.');
}

export async function onMessage(message) {
  if (!authorized(message.from, message.chat, config)) {
    if (message.chat?.type === 'private') await say(message.chat.id, 'Доступ запрещён.');
    return;
  }
  const uid = message.from.id;
  let draft = await ensure(uid);
  const text = message.text?.trim() || '';
  if (['/start', '/draft', '/help'].includes(text)) return show(draft);
  if (['publishing', 'uncertain'].includes(draft.state)) return show(draft);
  if (text === '/cancel') {
    if (['published', 'empty', 'cancelled'].includes(draft.state)) return show(draft);
    const next = await save(draft, 'cancelled', {});
    return next ? show(next) : say(uid, 'Черновик изменился. Откройте /draft.');
  }
  // Re-read/re-apply on conflicts so concurrent album updates don't lose photos.
  for (let attempt = 0; attempt < 10; attempt++) {
    if ((draft.data.messageIds || []).includes(message.message_id)) return;
    let state = draft.state;
    const data = { ...draft.data };
    if (state === 'date') {
      const date = parseDate(text, config.utcOffsetMinutes);
      if (!date) return say(uid, 'Введите существующую дату ДД.ММ.ГГГГ: от сегодня до года вперёд.');
      data.date = date; state = 'subject';
    } else if (state === 'title') {
      if (!text || text.length > 300 || /[\u0000-\u001f\u007f]/.test(text)) return say(uid, 'Название: 1–300 символов, одна строка.');
      data.title = text; state = 'photos';
    } else if (state === 'photos') {
      const photo = message.photo?.[message.photo.length - 1];
      if (!photo?.file_id || !photo.file_unique_id) return say(uid, 'Отправьте фотографию как фото, не как файл.');
      if (photo.file_size > 10 * 1024 * 1024) return say(uid, 'Фото превышает 10 МБ.');
      if (data.photos.some(p => p.uniqueId === photo.file_unique_id)) return say(uid, 'Эта фотография уже добавлена.');
      if (data.photos.length >= 10) return say(uid, 'Достигнут лимит 10 фото. Используйте последнюю кнопку предпросмотра или /draft.');
      data.photos = [...data.photos, { fileId: photo.file_id, uniqueId: photo.file_unique_id }];
    } else return show(draft);
    data.messageIds = [...(data.messageIds || []), message.message_id];
    const next = await save(draft, state, data);
    if (next) return show(next);
    draft = await load(uid);
  }
  return say(uid, 'Черновик занят. Проверьте /draft и отправьте недостающие фото ещё раз.');
}
