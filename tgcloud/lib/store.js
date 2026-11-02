import { db } from 'sdk';

export async function load(userId) {
  const row = await db.get('SELECT * FROM homework_drafts WHERE user_id = :uid', { ':uid': userId });
  return row ? { userId, revision: row.revision, state: row.state, data: JSON.parse(row.payload) } : null;
}
export async function ensure(userId) {
  await db.run("INSERT INTO homework_drafts (user_id, revision, state, payload) VALUES (:uid, 0, 'empty', '{}') ON CONFLICT(user_id) DO NOTHING", { ':uid': userId });
  return load(userId);
}
export async function save(old, state, data) {
  const result = await db.run('UPDATE homework_drafts SET revision = revision + 1, state = :state, payload = :payload WHERE user_id = :uid AND revision = :revision AND state = :oldstate', {
    ':uid': old.userId, ':revision': old.revision, ':oldstate': old.state, ':state': state, ':payload': JSON.stringify(data),
  });
  return result.rowsAffected === 1 ? { ...old, revision: old.revision + 1, state, data } : null;
}
export async function record(id, draft, channelId) {
  await db.run("INSERT INTO homework_publications (id, user_id, status, payload, channel_id, message_ids) VALUES (:id, :uid, 'sending', :payload, :channel, '[]')", {
    ':id': id, ':uid': draft.userId, ':payload': JSON.stringify(draft.data), ':channel': String(channelId),
  });
}
export async function finish(id, status, messageIds = []) {
  await db.run('UPDATE homework_publications SET status = :status, message_ids = :ids WHERE id = :id', {
    ':id': id, ':status': status, ':ids': JSON.stringify(messageIds),
  });
}
