// Public identifiers only. Empty allowlist denies everyone until configured.
export const config = {
  allowedUserIds: [2045764370], // Telegram ID разрешённых пользователей
  channelId: '-1002389393705', // ID канала или @username
  utcOffsetMinutes: 180, // Московское время (UTC+3)

  types: [
    'Домашняя работа',
    'Классная работа',
    'Подготовка к контрольной',
  ],

  subjects: [
    'Математика',
    'Алгебра',
    'Геометрия',
    'Русский язык',
    'Литература',
    'Английский язык',
    'История',
    'Биология',
    'География',
    'Физика',
    'Химия',
    'Информатика',
  ],
};
