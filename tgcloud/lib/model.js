export function localDate(offset, now = Date.now()) {
  return new Date(now + offset * 60000).toISOString().slice(0, 10);
}
export function parseDate(value, offset, now = Date.now()) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return null;
  const today = localDate(offset, now);
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCFullYear(limit.getUTCFullYear() + 1);
  return iso >= today && iso <= limit.toISOString().slice(0, 10) ? iso : null;
}
export function caption(data) {
  return `${data.type}\nДата: ${data.date.split('-').reverse().join('.')}\nПредмет: ${data.subject}\nЗадание: ${data.title}`;
}
export function validDraft(data, config) {
  return config.types.includes(data.type) && config.subjects.includes(data.subject)
    && typeof data.date === 'string' && parseDate(data.date.split('-').reverse().join('.'), config.utcOffsetMinutes) === data.date
    && typeof data.title === 'string' && data.title.trim().length > 0 && data.title.length <= 300
    && Array.isArray(data.photos) && data.photos.length >= 1 && data.photos.length <= 10
    && data.photos.every(p => typeof p.fileId === 'string' && p.fileId.length > 0)
    && new Set(data.photos.map(p => p.uniqueId)).size === data.photos.length
    && caption(data).length <= 1024;
}
export function authorized(user, chat, config) {
  return Number.isSafeInteger(user?.id) && user.id > 0 && !user.is_bot && chat?.type === 'private'
    && chat.id === user.id && config.allowedUserIds.includes(user.id);
}
export function channelConfigured(config) {
  return /^-100\d+$/.test(String(config.channelId)) || /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(config.channelId);
}
