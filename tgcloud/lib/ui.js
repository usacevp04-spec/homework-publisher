import { api } from 'sdk';
import { config } from './config.js';
import { caption } from './model.js';

export const say = (chatId, text, buttons = []) => api.sendMessage({
  chat_id: chatId, text, ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
});
export function button(draft, text, action) {
  return { text, callback_data: `hw:${draft.revision}:${action}` };
}
export async function media(chatId, data) {
  const text = caption(data);
  if (data.photos.length === 1) {
    return [await api.sendPhoto({ chat_id: chatId, photo: data.photos[0].fileId, caption: text })];
  }
  return api.sendMediaGroup({ chat_id: chatId, media: data.photos.map((photo, i) => ({
    type: 'photo', media: photo.fileId, ...(i === 0 ? { caption: text } : {}),
  })) });
}
export async function show(draft) {
  const id = draft.userId;
  const b = (text, action) => button(draft, text, action);
  const cancel = [b('Отменить черновик', 'cancel')];
  if (draft.state === 'type') return say(id, 'Выберите тип задания:', [...config.types.map((text, i) => [b(text, `type_${i}`)]), cancel]);
  if (draft.state === 'date') return say(id, 'Введите дату ДД.ММ.ГГГГ (от сегодня до года вперёд, московское время):', [cancel]);
  if (draft.state === 'subject') return say(id, 'Выберите предмет:', [...config.subjects.map((text, i) => [b(text, `subject_${i}`)]), cancel]);
  if (draft.state === 'title') return say(id, 'Введите название задания (1–300 символов):', [cancel]);
  if (draft.state === 'photos') return say(id, `Пришлите 1–10 фотографий как фото, по одной или альбомом. Получено: ${draft.data.photos.length}. Затем нажмите «Предпросмотр».`, [[b('Предпросмотр', 'preview')], [b('Очистить фотографии', 'clear')], cancel]);
  if (draft.state === 'preview') {
    await media(id, draft.data);
    return say(id, `Предпросмотр. Фотографий: ${draft.data.photos.length}. Канал: ${config.channelId || 'не настроен'}. Опубликовать?`, [[b('Подтвердить публикацию', 'publish')], [b('Вернуться к фотографиям', 'edit')], cancel]);
  }
  if (['publishing', 'uncertain'].includes(draft.state)) return say(id, 'Публикация выполняется либо её результат неизвестен. Повторная отправка заблокирована. Проверьте канал и журнал публикаций; обратитесь к администратору.');
  return say(id, draft.state === 'published' ? 'Задание опубликовано.' : 'Homework Publisher. Создайте новое задание.', [[b('Новое задание', 'new')]]);
}
