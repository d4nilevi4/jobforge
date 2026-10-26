import { api } from './api.js';
import { h, button, field, busy, copyText, clear } from './dom.js';

const descriptions = {
  agent: 'Can read your profile and file applications, resume variants, and templates. Cannot edit your profile or approve applications.',
  setup: 'Also allows editing your profile. Use this when an agent fills your profile from a CV.',
  owner: 'Full access, including approvals, token management, export, and deletion.'
};

function tokenResult(token, preset) {
  const origin = location.origin;
  const task = preset === 'setup' ? 'fill my profile from the attached CV. Copy only facts supported by the CV and ask about anything missing.' : preset === 'agent' ? 'find vacancies and file tailored applications for my review.' : 'help me manage my JobForge workspace.';
  const prompt = `Use the JobForge API at ${origin}/api/v1 with this token: ${token.secret}. Read ${origin}/api/v1/guide first, then ${task}`;
  return h('div', { className: 'card' }, h('h3', {}, 'Copy this token now'), h('p', { className: 'muted' }, 'This secret is shown only once. It will disappear when you leave this page.'), field('Token secret', h('input', { value: token.secret, readOnly: true, className: 'mono secret', autocomplete: 'off', spellcheck: 'false' })), button('Copy token', () => copyText(token.secret)), h('hr'), field('Ready-to-paste prompt', h('textarea', { readOnly: true, value: prompt, rows: 6 })), button('Copy prompt', () => copyText(prompt)));
}

export function setupAgentBox() {
  const errors = h('div');
  const result = h('div');
  const create = button('Create setup token and prompt', () => busy(create, errors, async () => {
    const token = await api.post('/tokens', { name: 'Profile setup', preset: 'setup' });
    clear(result, tokenResult(token, 'setup'));
  }), 'primary');
  return h('section', { className: 'callout' }, h('h2', {}, 'Let an agent fill this in'), h('p', {}, 'Create a setup token, copy the prompt to your agent, and attach your CV. You can also fill the forms by hand.'), create, errors, result);
}

export function tokenCreator(onCreated) {
  const name = h('input', { required: true, maxlength: 200, placeholder: 'Agent name', autocomplete: 'off' });
  const preset = h('select', {}, ['agent', 'setup', 'owner'].map(value => h('option', { value }, value)));
  const hint = h('p', { className: 'muted small' }, descriptions.agent);
  const errors = h('div');
  const result = h('div');
  const submit = h('button', { type: 'submit', className: 'primary' }, 'Create token');
  preset.addEventListener('change', () => { hint.textContent = descriptions[preset.value]; });
  const form = h('form', {}, h('div', { className: 'form-grid' }, field('Token name', name), field('Preset', preset)), hint, errors, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    busy(submit, errors, async () => {
      const selected = preset.value;
      const token = await api.post('/tokens', { name: name.value.trim(), preset: selected });
      clear(result, tokenResult(token, selected));
      name.value = '';
      if (onCreated) await onCreated();
    });
  });
  return h('div', {}, form, result);
}
