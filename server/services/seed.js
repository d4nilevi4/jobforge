import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createToken, PRESETS } from '../auth.js';
import { conflict, renderFailed, validationFailed } from '../errors.js';
import { check } from '../guard.js';
import { renderPdf as defaultRenderPdf } from '../render/index.js';
import { findChrome } from '../render/pdf.js';
import { validateDocument } from '../upgrade.js';
import { createApplication, setStatus } from './applications.js';
import { saveProfile } from './profile.js';
import { saveTrack } from './tracks.js';

const vacancies = [
  ['Orbit Games', 'Unity Gameplay Engineer', 'unity-developer', 'draft', 'manual'],
  ['Ledgerly', 'Go Backend Engineer', 'go-backend', 'draft', 'linkedin'],
  ['Harbor Labs', 'Hands-on Technical Director', 'technical-director', 'needs_review', 'hirify'],
  ['Orbit Games', 'Unity Tools Engineer', 'unity-developer', 'approved', 'manual'],
  ['Quay Systems', 'Go Services Lead', 'go-backend', 'sent', 'linkedin'],
  ['Meadow Studio', 'Technical Director', 'technical-director', 'skipped', 'hirify']
];

function vacancyText(company, title, track) {
  const focus = track === 'unity-developer'
    ? 'Unity gameplay systems, C# development, frame profiling, and editor tools for designers'
    : track === 'go-backend'
      ? 'Go services, PostgreSQL queries, event processing, and reliable release practices'
      : 'technical planning, architecture reviews, mentoring, and delivery across engineering teams';
  return `${company} is hiring a ${title} to help a small remote team build dependable products. The role focuses on ${focus}. You will work directly with product colleagues to turn clear requirements into maintainable implementations, review changes, and explain technical tradeoffs. We value engineers who can investigate performance problems, make practical improvements, and document decisions for the next person. The team plans work in small milestones and uses automated checks before each release. Applicants should describe relevant projects, their individual contribution, and the results they measured. This is a remote position with regular collaboration during shared working hours. Please include a concise resume and a short cover letter explaining which recorded experience fits these responsibilities.`;
}

function tailoredResume(track, title, index) {
  const content = structuredClone(track.base);
  content.headline = title;
  content.summary = track.base.summary;
  if (index === 2) content.summary += ' I propose a 45 minute architecture discussion to agree the first milestone.';
  content.experience = content.experience.slice(0, 2).map((entry) => {
    const bullets = entry.bullets.slice(0, 2);
    if (index % 2) bullets.reverse();
    return { ...entry, bullets };
  });
  content.projects = (content.projects ?? []).slice(0, 1).map((entry) => ({ ...entry, bullets: entry.bullets.slice(0, 1) }));
  return content;
}

function coverText(content, title, company) {
  const first = content.experience[0];
  const facts = first.bullets.slice(0, 2).map((bullet) => `I ${bullet[0].toLowerCase()}${bullet.slice(1)}`).join(' ');
  return `I am applying for the ${title} role at ${company}. My experience at ${first.company} fits the responsibilities in your vacancy.\n\n${facts}\n\nI would bring that experience to your team and discuss the implementation and release decisions behind this work.`;
}

function ownerToken(db) {
  for (const row of db.prepare('SELECT id, scopes FROM tokens WHERE revoked_at IS NULL ORDER BY id').all()) {
    const scopes = JSON.parse(row.scopes);
    if (PRESETS.owner.every((scope) => scopes.includes(scope))) return { id: row.id, scopes };
  }
  return createToken(db, { name: 'demo seed owner', preset: 'owner' });
}

export async function seedDemo(db, { dataDir, chrome, deps = {}, force = false } = {}) {
  for (const table of ['profile', 'profile_revisions', 'tracks', 'templates', 'template_versions', 'applications', 'application_events']) {
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw conflict(`Demo seeding requires an empty content store, but ${table} contains data${force ? ', including with --force' : ''}. Use a fresh DATA_DIR; seed-demo never overwrites or deletes user data.`);
    }
  }
  const renderer = deps.renderPdf ?? defaultRenderPdf;
  const browser = deps.chrome ?? chrome ?? { bin: findChrome() };
  if (renderer === defaultRenderPdf && !(typeof browser === 'string' ? browser : browser?.bin || browser?.chromeBin)) {
    throw renderFailed('Demo seeding needs Chrome to create PDFs. Install Google Chrome or Chromium, or set CHROME_BIN, then retry seed-demo.');
  }
  const profile = validateDocument('profile', JSON.parse(readFileSync(new URL('../../examples/profile.example.json', import.meta.url), 'utf8')));
  if (profile.errors.length) throw validationFailed('The example profile is invalid. Correct the example before seeding.', profile.errors);
  const tracks = JSON.parse(readFileSync(new URL('../../examples/tracks.example.json', import.meta.url), 'utf8'));
  let owner;
  const created = [];
  db.exec('SAVEPOINT seed_demo');
  try {
    owner = ownerToken(db);
    const options = { dataDir, token: owner, renderPdf: renderer, chrome: browser };
    saveProfile(db, profile.doc, owner.id);
    for (const [id, input] of Object.entries(tracks)) {
      const track = validateDocument('track', input);
      const guard = check({ content: track.doc.base, profile: profile.doc });
      if (track.errors.length || guard.errors.length) throw validationFailed(`Example track ${id} failed validation. Correct it before seeding.`, [...track.errors, ...guard.errors]);
      saveTrack(db, id, track.doc);
    }
    for (const [index, [company, title, trackId, status, source]] of vacancies.entries()) {
      const track = tracks[trackId];
      const skip = status === 'skipped';
      const resume = skip ? null : tailoredResume(track, title, index);
      const input = {
        vacancy: { url: `https://example.com/jobs/demo-${index + 1}`, source, title, company, location: 'Remote', language: 'en', text: vacancyText(company, title, trackId) },
        verdict: skip ? 'skip' : index === 2 ? 'maybe' : 'apply', score: skip ? 0.2 : 0.85, track_id: trackId,
        notes: skip ? 'Demo: scope does not fit the preferred hands-on role.' : 'Demo application derived from the example profile.'
      };
      if (resume) {
        input.resume = { template: track.resume_template, content: resume };
        input.cover = { template: track.cover_template, content: { schema_version: 1, language: 'en', text: coverText(resume, title, company) } };
      }
      const application = await createApplication(db, input, options);
      created.push(application.id);
      if (status !== application.status) {
        setStatus(db, application.id, { status, note: status === 'needs_review' ? 'Review the proposed 45 minute discussion; it is a suggestion, not a historical achievement.' : 'Demo review completed by the seed owner.' }, options);
      }
    }
    db.exec('RELEASE seed_demo');
  } catch (error) {
    db.exec('ROLLBACK TO seed_demo; RELEASE seed_demo');
    if (dataDir) for (const id of created) rmSync(join(dataDir, 'files', String(id)), { recursive: true, force: true });
    throw error;
  }
  return { ok: true, created, ...(owner.secret ? { owner_token: owner.secret } : {}) };
}
