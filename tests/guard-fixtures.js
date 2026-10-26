export const profile = {
  schema_version: 1,
  identity: { name: 'Alex Example', email: 'alex@example.com', links: [{ label: 'Website', url: 'https://example.com' }] },
  about: 'An engineer who builds reliable tools.',
  experience: [{
    id: 'example',
    company: 'Example Works',
    title: 'Engineer',
    dates: '2021 - 2024',
    location: '',
    bullets: ['Reduced build time by 40% and maintained 12 tools.'],
  }],
  projects: [{ id: 'tool', title: 'Example Tool (desktop)', tech: 'Go, SQLite', link: '', link_label: '', bullets: [] }],
  education: [{ institution: 'Example University', degree: 'BSc', years: '2010 - 2014' }],
  skills: [
    { key: 'programming_languages', label: 'Languages', label_localized: { ru: 'Языки' }, items: ['Go', 'C#', 'C++', 'JavaScript'] },
    { key: 'tools', label: 'Tools', label_localized: { ru: 'Инструменты' }, items: ['SQLite', '.NET', 'Node.js', 'Version control', 'Git'] },
  ],
  familiar: [{ item: 'Kubernetes', qualifier: 'coursework' }],
  languages: [{ name: 'English', level: 'B2' }],
  do_not_claim: [{ text: 'Never claim team lead experience', patterns: ['\\bteam lead\\b'] }],
  rules: {
    forbid_patterns: [{ pattern: '—', message: 'Use a short dash instead of a long dash' }],
    cover_max_words: 160,
    notes: 'Write clear, factual text.',
  },
};

export const cleanContent = {
  schema_version: 1,
  language: 'en',
  headline: 'Software Engineer',
  summary: 'Builds reliable tools with clear interfaces.',
  experience: [{
    company: 'Example Works',
    title: 'Engineer',
    dates: '2021 - 2024',
    location: '',
    bullets: ['Reduced build time by 40%.', 'Maintained reliable tools.'],
  }],
  projects: [{ title: 'Example Tool', tech: 'Go, SQLite', link: 'https://example.com', link_label: 'Website', bullets: ['Built a reliable desktop tool.'] }],
  skills: [{ label: 'Languages', items: 'Go, C#; C++' }, { label: 'Tools', items: 'SQLite, Node.js, Version control (Git)' }],
  education: [{ institution: 'Example University', degree: 'BSc', years: '2010 - 2014' }],
  extra: {},
};
