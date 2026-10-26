import { paragraphs } from './engine.js';
import { labelsFor } from './labels.js';

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
      links: (identity.links ?? []).map(({ label, url }) => ({
        label,
        url,
        display: url.replace(/^[a-z][a-z\d+.-]*:(?:\/\/)?/i, '').replace(/\/+$/, '')
      }))
    },
    lang: language,
    labels: labelsFor(meta, language),
    paper: meta?.paper || 'letter',
    resume,
    cover,
    paragraphs: paragraphs(cover?.text)
  };
}
