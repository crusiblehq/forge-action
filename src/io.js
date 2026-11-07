// Runner IO: inputs, outputs, masking. No dependencies.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function getInput(name, env = process.env) {
  const v = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return (v ?? '').trim();
}

export function mask(value, out = (s) => process.stdout.write(s)) {
  if (value) out(`::add-mask::${value}\n`);
}

export function setOutput(name, value, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!file) return;
  const d = `ghadelim_${randomUUID()}`;
  appendFileSync(file, `${name}<<${d}\n${text}\n${d}\n`);
}

// Strip the token from any text before it reaches a log.
export function scrub(text, token) {
  return token ? String(text).split(token).join('***') : String(text);
}

export function list(raw) {
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}
