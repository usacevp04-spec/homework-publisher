import { onMessage } from '../lib/bot.js';
export default async function (message) {
  await onMessage(message);
}
