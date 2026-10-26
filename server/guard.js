import { runInNewContext } from 'node:vm';

const RUSSIAN_QUALIFIERS = new Map([
  ['coursework', /курсов|курсу|учебн|учёб/iu],
  ['university', /университет|вуз|учеб|учёб/iu],
]);

const array = (value) => Array.isArray(value) ? value : [];
const isText = (value) => typeof value === 'string';
const normalizeName = (value) => isText(value) ? value.trim().replace(/\s+/gu, ' ').toLowerCase() : '';

export function normalizeToken(value) {
  const text = normalizeName(value).replace(/[•·]/gu, ' ').replace(/\s+/gu, ' ').trim();
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || text[end - 1] === ';')) end -= 1;
  return text.slice(0, end);
}

export function safeTest(regex, text, { timeoutMs = 100 } = {}) {
  return runInNewContext('re.test(s)', { re: regex, s: text }, { timeout: timeoutMs });
}

function similar(left, right) {
  return Boolean(left && right) && (left === right || (
    left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))
  ));
}

function wholeWord(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_+#])${escaped}(?![\\p{L}\\p{N}_+#])`, 'iu');
}

function hasQualifier(text, qualifier) {
  return wholeWord(qualifier).test(text) || Boolean(RUSSIAN_QUALIFIERS.get(qualifier)?.test(text));
}

function splitSkills(text) {
  const tokens = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    if ((character === ',' || character === ';') && depth === 0) {
      tokens.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  tokens.push(text.slice(start).trim());
  return tokens.filter(Boolean);
}

function skillIndex(profile) {
  return array(profile?.skills).flatMap((group) => array(group?.items))
    .filter(isText).map(normalizeToken).filter(Boolean);
}

function familiarItems(profile) {
  return array(profile?.familiar).filter((entry) => normalizeToken(entry?.item) && normalizeName(entry?.qualifier))
    .map((entry) => ({
      item: entry.item,
      qualifier: normalizeName(entry.qualifier),
      pattern: wholeWord(entry.item.trim()),
    }));
}

function unqualifiedItems(text, familiar) {
  return familiar.filter((entry) => entry.pattern.test(text) && !hasQualifier(text, entry.qualifier));
}

function stripParens(text) {
  return normalizeToken(text.replace(/\([^()]*\)/gu, ' '));
}

function allowedSkill(token, known, familiar) {
  const normalized = normalizeToken(token);
  if (!normalized || unqualifiedItems(token, familiar).length) return false;
  if (known.includes(normalized)) return true;

  const parentheticals = [...token.matchAll(/\(([^()]*)\)/gu)];
  const outside = stripParens(token);
  const inside = parentheticals.flatMap((match) => splitSkills(match[1]));
  const qualified = familiar.filter((entry) => entry.pattern.test(token) && hasQualifier(token, entry.qualifier));
  if (qualified.some((entry) => entry.pattern.test(outside)) && inside.every((part) => (
    qualified.some((entry) => hasQualifier(part, entry.qualifier)) || allowedSkill(part, known, familiar)
  ))) return true;

  // Check parenthetical details before loose matching, so a known phrase cannot hide an invented tool.
  if (parentheticals.length) {
    return known.some((entry) => similar(stripParens(entry), outside)) && inside.length > 0
      && inside.every((part) => allowedSkill(part, known, familiar));
  }
  return known.some((entry) => similar(entry, normalized));
}

export function skillAllowed(token, profile) {
  return isText(token) && allowedSkill(token, skillIndex(profile), familiarItems(profile));
}

function contentFields(content) {
  const fields = [];
  const add = (path, value, options = {}) => {
    if (isText(value)) fields.push({ path, value, ...options });
  };
  const bullets = (path, values) => array(values).forEach((value, index) => {
    add(`${path}[${index}]`, value, { prose: true, bullet: true, numbers: true, language: content?.language });
  });
  add('language', content?.language);
  add('headline', content?.headline, { prose: true, language: content?.language });
  add('summary', content?.summary, { prose: true, numbers: true, language: content?.language });
  array(content?.experience).forEach((entry, index) => {
    const path = `experience[${index}]`;
    for (const key of ['company', 'title', 'dates', 'location']) add(`${path}.${key}`, entry?.[key]);
    bullets(`${path}.bullets`, entry?.bullets);
  });
  array(content?.projects).forEach((entry, index) => {
    const path = `projects[${index}]`;
    for (const key of ['title', 'tech', 'link', 'link_label']) {
      add(`${path}.${key}`, entry?.[key], { prose: key === 'tech' });
    }
    bullets(`${path}.bullets`, entry?.bullets);
  });
  array(content?.skills).forEach((entry, index) => {
    for (const key of ['label', 'items']) add(`skills[${index}].${key}`, entry?.[key]);
  });
  array(content?.education).forEach((entry, index) => {
    for (const key of ['institution', 'degree', 'years']) add(`education[${index}].${key}`, entry?.[key]);
  });
  return fields;
}

function issue(path, code, message) {
  return { path, code, message };
}

function compileRules(profile, warnings) {
  const rules = [];
  const compiled = new Map();
  const add = (pattern, code, text, source) => {
    if (!isText(pattern)) return;
    if (!compiled.has(pattern)) {
      try {
        compiled.set(pattern, new RegExp(pattern, 'iu'));
      } catch {
        compiled.set(pattern, null);
      }
    }
    if (compiled.get(pattern)) {
      rules.push({ pattern: compiled.get(pattern), rawPattern: pattern, code, text: isText(text) ? text : pattern, source });
    } else {
      // Profile mistakes have no resume field; use the document root and identify the profile path in the message.
      warnings.push(issue('', 'profile_rule_invalid',
        `Invalid regular expression ${JSON.stringify(pattern)} at ${source}. Fix the profile pattern so it compiles with flags "iu"; this pattern was skipped.`));
    }
  };
  array(profile?.do_not_claim).forEach((entry, index) => {
    array(entry?.patterns).forEach((pattern, patternIndex) => {
      add(pattern, 'do_not_claim', entry?.text, `profile.do_not_claim[${index}].patterns[${patternIndex}]`);
    });
  });
  array(profile?.rules?.forbid_patterns).forEach((entry, index) => {
    add(entry?.pattern, 'forbidden_pattern', entry?.message, `profile.rules.forbid_patterns[${index}].pattern`);
  });
  return rules;
}

function normalizeDates(value) {
  return value.trim().replace(/\s+/gu, '').replace(/[\u2010-\u2015\u2212]/gu, '-').toLowerCase();
}

function projectTitle(value) {
  const text = value.trim();
  if (!text.endsWith(')')) return normalizeName(text);
  let depth = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] === ')') depth += 1;
    if (text[index] === '(') {
      depth -= 1;
      if (depth === 0) return normalizeName(text.slice(0, index));
    }
  }
  return normalizeName(text);
}

function checkExperience(content, profile, errors) {
  const known = array(profile?.experience).filter((entry) => isText(entry?.company));
  array(content?.experience).forEach((entry, index) => {
    if (!isText(entry?.company)) return;
    const path = `experience[${index}]`;
    const matches = known.filter((candidate) => normalizeName(candidate.company) === normalizeName(entry.company));
    if (!matches.length) {
      errors.push(issue(`${path}.company`, 'unknown_employer',
        `Employer ${JSON.stringify(entry.company)} at ${path}.company is not in the profile. Known: ${known.map((candidate) => candidate.company).join(', ') || '(none)'}. Use a known employer or add verified facts to the profile.`));
      return;
    }
    const dates = matches.map((candidate) => candidate.dates).filter(isText);
    if (isText(entry.dates) && dates.length && !dates.some((value) => normalizeDates(value) === normalizeDates(entry.dates))) {
      errors.push(issue(`${path}.dates`, 'date_mismatch',
        `Dates ${JSON.stringify(entry.dates)} at ${path}.dates do not match profile dates ${dates.map((value) => JSON.stringify(value)).join(', ')} for ${JSON.stringify(entry.company)}. Use the profile dates.`));
    }
  });
}

function checkProjects(content, profile, errors) {
  const known = array(profile?.projects).map((entry) => entry?.title).filter(isText);
  array(content?.projects).forEach((entry, index) => {
    if (!isText(entry?.title)) return;
    const title = projectTitle(entry.title);
    if (title && known.some((candidate) => {
      const normalized = projectTitle(candidate);
      return normalized === title;
    })) return;
    const path = `projects[${index}].title`;
    errors.push(issue(path, 'unknown_project',
      `Project ${JSON.stringify(entry.title)} at ${path} is not in the profile. Known: ${known.join(', ') || '(none)'}. Use a known project title or add verified facts to the profile.`));
  });
}

function checkSkills(content, profile, familiar, errors) {
  const known = skillIndex(profile);
  const labels = array(profile?.skills).flatMap((group) => [
    group?.label,
    ...Object.values(group?.label_localized && typeof group.label_localized === 'object' ? group.label_localized : {}),
    isText(group?.key) ? group.key.replace(/_/gu, ' ') : '',
  ]).filter(isText).map(normalizeName).filter(Boolean);
  array(content?.skills).forEach((group, index) => {
    if (isText(group?.label) && !labels.includes(normalizeName(group.label))) {
      const path = `skills[${index}].label`;
      errors.push(issue(path, 'unknown_skill_group',
        `Skill group ${JSON.stringify(group.label)} at ${path} is not in the profile. Known labels: ${labels.join(', ') || '(none)'}. Use a profile label, localized label, or group key with spaces.`));
    }
    if (!isText(group?.items)) return;
    const path = `skills[${index}].items`;
    const unknown = [];
    for (const token of splitSkills(group.items)) {
      const unqualified = unqualifiedItems(token, familiar);
      for (const entry of unqualified) errors.push(familiarIssue(path, token, entry));
      if (!unqualified.length && !allowedSkill(token, known, familiar)) unknown.push(token);
    }
    if (unknown.length) errors.push(issue(path, 'unknown_skill',
      `Unknown skills at ${path}: ${unknown.map((token) => JSON.stringify(token)).join(', ')}. Use profile skills or qualify familiar items as specified in the profile.`));
  });
}

function checkEducation(content, profile, errors) {
  const known = array(profile?.education).filter((entry) => isText(entry?.institution));
  const keys = ['institution', 'degree', 'years'];
  const normalized = (entry, key) => key === 'years' && isText(entry?.[key])
    ? normalizeDates(entry[key]) : normalizeName(entry?.[key]);
  array(content?.education).forEach((entry, index) => {
    if (!isText(entry?.institution)) return;
    const candidates = known.map((candidate) => ({
      candidate,
      differing: keys.filter((key) => !isText(entry[key]) || !isText(candidate[key])
        || normalized(entry, key) !== normalized(candidate, key)),
    })).sort((left, right) => left.differing.length - right.differing.length);
    const closest = candidates[0];
    if (closest && !closest.differing.length) return;
    const path = `education[${index}].${closest?.differing[0] ?? 'institution'}`;
    const details = closest
      ? `Closest profile entry: ${JSON.stringify(closest.candidate)}. Fields that differ: ${closest.differing.join(', ')}.`
      : 'The profile has no education entries.';
    errors.push(issue(path, 'unknown_education',
      `Education ${JSON.stringify(entry)} at education[${index}] does not match profile.education. ${details} Use the matching institution, degree and years from the profile or add verified education to the profile.`));
  });
}

function familiarIssue(path, text, entry) {
  return issue(path, 'familiar_unqualified',
    `Unqualified ${JSON.stringify(entry.item)} in ${JSON.stringify(text)} at ${path}. Include qualifier ${JSON.stringify(entry.qualifier)} or its Russian equivalent in the same text field.`);
}

function numberMatches(text) {
  return [...text.matchAll(/(?<![\p{L}\p{N}_])\d+(?:[.,]\d+)*(?:%|[kKmMxX])?(?![\p{L}\p{N}_])/gu)]
    .filter((match) => match[0].replace(/\D/gu, '').length >= 2);
}

function numbersIn(text) {
  return numberMatches(text).map((match) => match[0].toLowerCase());
}

function profileText(value) {
  if (isText(value) || typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object') return '';
  return Object.values(value).map(profileText).join(' ');
}

function checkNumbers(fields, profile, warnings) {
  const known = new Set(numbersIn(profileText(profile)));
  const seen = new Set();
  for (const field of fields.filter((entry) => entry.numbers)) {
    for (const match of numberMatches(field.value)) {
      const number = match[0].toLowerCase();
      if (/^\d{4}$/u.test(number) && Number(number) >= 1990 && Number(number) <= 2100
        && !/^\s+\p{Ll}/u.test(field.value.slice(match.index + match[0].length))) continue;
      if (known.has(number) || seen.has(number)) continue;
      seen.add(number);
      warnings.push(issue(field.path, 'number_not_in_profile',
        `Number ${JSON.stringify(number)} at ${field.path} does not appear in the profile. Remove it or add the verified number to the profile.`));
    }
  }
}

function checkLanguage({ value, language, path }, warnings) {
  if (!isText(language)) return;
  const normalized = language.toLowerCase();
  const wrongScript = normalized.startsWith('en') ? /\p{Script=Cyrillic}/u
    : normalized.startsWith('ru') ? /\p{Script=Latin}/u : null;
  if (!wrongScript) return;
  const letters = value.match(/\p{L}/gu) || [];
  const wrongLetters = letters.filter((letter) => wrongScript.test(letter));
  const words = value.match(/\p{L}+/gu) || [];
  const wrongWords = words.filter((word) => wrongScript.test(word));
  if (wrongWords.length >= 3 && wrongLetters.length > letters.length * 0.3) {
    warnings.push(issue(path, 'wrong_language',
      `Text at ${path} does not appear to match language ${JSON.stringify(language)}. Write this part in the document's language or correct its language field.`));
  }
}

function hasCodeLineCount(text) {
  if (/lines of code/iu.test(text)) return true;
  const label = /(?:loc\b|строк кода)/iuy;
  for (const match of text.matchAll(/(?<![\p{L}\p{N}_])\d[\d,.]*/gu)) {
    let index = match.index + match[0].length;
    while (index < text.length && /\s/u.test(text[index])) index += 1;
    if (/[kKmM]/u.test(text[index] ?? '')) index += 1;
    if (text[index] === '+') index += 1;
    while (index < text.length && /\s/u.test(text[index])) index += 1;
    label.lastIndex = index;
    if (label.test(text)) return true;
  }
  return false;
}

function runChecks(content, cover, profile) {
  const errors = [];
  const warnings = [];
  const fields = contentFields(content);
  for (const key of ['language', 'text']) {
    if (isText(cover?.[key])) fields.push({
      path: `cover.${key}`, value: cover[key], prose: key === 'text',
      language: key === 'text' ? cover.language : undefined,
    });
  }
  const rules = compileRules(profile, warnings);
  const timedOut = new Set();
  const familiar = familiarItems(profile);
  checkExperience(content, profile, errors);
  checkProjects(content, profile, errors);
  checkSkills(content, profile, familiar, errors);
  checkEducation(content, profile, errors);
  checkNumbers(fields, profile, warnings);
  for (const field of fields) {
    checkLanguage(field, warnings);
    if (field.prose) {
      for (const entry of unqualifiedItems(field.value, familiar)) errors.push(familiarIssue(field.path, field.value, entry));
    }
    for (const rule of rules) {
      if (timedOut.has(rule.rawPattern)) continue;
      try {
        if (safeTest(rule.pattern, field.value)) errors.push(issue(field.path, rule.code,
          `Text at ${field.path} matches ${rule.source}: ${JSON.stringify(rule.text)}. Remove or rewrite the matching text to follow this profile rule.`));
      } catch (error) {
        if (error.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw error;
        timedOut.add(rule.rawPattern);
        warnings.push(issue(field.path, 'profile_rule_timeout',
          `Pattern ${JSON.stringify(rule.rawPattern)} at ${rule.source} took too long and was skipped for the rest of this check; simplify it in the profile.`));
      }
    }
    if (field.bullet && hasCodeLineCount(field.value)) {
      warnings.push(issue(field.path, 'code_line_counts',
        `Bullet at ${field.path} mentions lines of code. Describe the verified outcome instead of a code line count.`));
    }
    if (field.bullet && field.value.length > 300) warnings.push(issue(field.path, 'bullet_too_long',
      `Bullet at ${field.path} has ${field.value.length} characters; the recommended maximum is 300. Shorten the bullet.`));
  }
  const limit = profile?.rules?.cover_max_words;
  if (isText(cover?.text) && typeof limit === 'number' && Number.isFinite(limit)) {
    const count = cover.text.trim() ? cover.text.trim().split(/\s+/u).length : 0;
    if (count > limit) errors.push(issue('cover.text', 'cover_too_long',
      `Cover at cover.text has ${count} words; profile.rules.cover_max_words allows ${limit}. Shorten the cover to at most ${limit} words.`));
  }
  const order = new Map(fields.map((field, index) => [field.path, index]));
  const compare = (left, right) => (order.get(left.path) ?? -1) - (order.get(right.path) ?? -1);
  return { errors: errors.sort(compare), warnings: warnings.sort(compare) };
}

export function check({ content, cover = null, profile } = {}) {
  return runChecks(content, cover, profile);
}

export function checkContent(content, profile) {
  return runChecks(content, null, profile);
}

export function checkCover(cover, profile) {
  return runChecks(null, cover, profile);
}
