import { table, integer, text } from 'sdk/db';

// One durable current draft per Telegram user; revision is an optimistic lock.
export const drafts = table('homework_drafts', {
  userId: integer('user_id').primaryKey(),
  revision: integer('revision').notNull(),
  state: text('state').notNull(),
  payload: text('payload').notNull(),
});

// Immutable publication identity and payload survive creation of the next draft.
export const publications = table('homework_publications', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  status: text('status').notNull(),
  payload: text('payload').notNull(),
  channelId: text('channel_id').notNull(),
  messageIds: text('message_ids').notNull(),
});
