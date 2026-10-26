export const DEFAULT_LABELS = {
  en: {
    summary: 'Summary',
    experience: 'Experience',
    projects: 'Projects',
    skills: 'Skills',
    education: 'Education',
    languages: 'Languages',
    links: 'Links',
    availability: 'Availability',
    contact: 'Contact',
    greeting: 'Hello,',
    closing: 'Sincerely,'
  },
  ru: {
    summary: 'О себе',
    experience: 'Опыт',
    projects: 'Проекты',
    skills: 'Навыки',
    education: 'Образование',
    languages: 'Языки',
    links: 'Ссылки',
    availability: 'Доступность',
    contact: 'Контакты',
    greeting: 'Здравствуйте,',
    closing: 'С уважением,'
  }
};

export function labelsFor(meta, lang = 'en') {
  const language = Object.hasOwn(DEFAULT_LABELS, lang) ? lang : 'en';
  return {
    ...DEFAULT_LABELS.en,
    ...meta?.labels?.en,
    ...DEFAULT_LABELS[language],
    ...meta?.labels?.[language]
  };
}
