import { paragraphs } from './engine.js';
import { labelsFor } from './labels.js';

export function safeUrl(value) {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)) return '';
  try {
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(value).protocol) ? value : '';
  } catch {
    return '';
  }
}

export function buildContext({ profile, meta, resume, cover, lang }) {
  const language = (meta?.kind === 'cover' ? cover?.language : resume?.language)
    || (!meta?.kind && cover?.language) || lang || 'en';
  const identity = profile?.identity ?? {};
  const availability = identity.availability ?? {};
  return {
    identity: {
      name: identity.name_localized?.[language] || identity.name || '',
      email: identity.email || '',
      phone: identity.phone || '',
      location: identity.location || '',
      availability: availability[language] || availability.en || Object.values(availability)[0] || '',
      links: (Array.isArray(identity.links) ? identity.links : []).filter((link) => link && typeof link === 'object').map(({ label, url }) => {
        const sanitized = safeUrl(url);
        return {
          label,
          url: sanitized,
          display: sanitized.replace(/^[a-z][a-z\d+.-]*:(?:\/\/)?/i, '').replace(/\/+$/, '')
        };
      })
    },
    lang: language,
    labels: labelsFor(meta, language),
    paper: meta?.paper || 'letter',
    resume: Array.isArray(resume?.projects) ? {
      ...resume,
      projects: resume.projects.filter((project) => project && typeof project === 'object')
        .map((project) => ({ ...project, link: safeUrl(project.link) }))
    } : resume,
    cover,
    paragraphs: paragraphs(cover?.text)
  };
}
