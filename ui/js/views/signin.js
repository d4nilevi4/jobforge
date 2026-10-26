import { api, setToken } from '../api.js';
import { h, clear, field, errorBox } from '../dom.js';

export async function signinView(root, { onSignin, error }) {
  const token = h('input', { type: 'password', autocomplete: 'off', required: true, spellcheck: 'false' });
  const errors = h('div', {}, error ? errorBox(error) : null);
  const submit = h('button', { type: 'submit', className: 'primary' }, 'Sign in');
  const form = h('form', { className: 'card signin' }, h('h1', {}, 'Sign in'), h('p', { className: 'muted' }, 'Use the owner token printed in the server console the first time it started. Create more with ', h('code', {}, 'npm run token'), '.'), field('Owner token', token), errors, submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clear(errors);
    submit.disabled = true;
    setToken(token.value);
    try { await api.get('/profile'); onSignin(); } catch (error) { clear(errors, errorBox(error, () => form.requestSubmit())); } finally { submit.disabled = false; }
  });
  root.append(form);
}
