import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { renderFailed } from '../errors.js';

const runFile = promisify(execFile);
let activeRenders = 0;
const pendingRenders = [];
let pendingHtmlBytes = 0;

function isFile(path, executable = false) {
  try {
    if (!path || !statSync(path).isFile()) return false;
    if (executable) accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findChrome(env = process.env) {
  const windowsRoots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA,
    'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean);
  const knownPaths = [
    env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    ...windowsRoots.flatMap((root) => [
      win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win32.join(root, 'Chromium', 'Application', 'chrome.exe'),
      win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      win32.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    ])
  ];
  for (const path of knownPaths) if (isFile(path)) return path;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    for (const directory of (env.PATH || '').split(delimiter).filter(Boolean)) {
      const path = join(directory, process.platform === 'win32' ? `${name}.exe` : name);
      if (isFile(path, true)) return path;
    }
  }
  return '';
}

export function chromeVersion(path) {
  if (!path) return '';
  try {
    return execFileSync(path, ['--version'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch {
    return '';
  }
}

function queueWaitError() {
  return renderFailed('PDF render queue wait exceeded 60000 ms. The server is busy; retry the PDF render later.');
}

function acquireRender(htmlBytes) {
  if (activeRenders < 2) {
    activeRenders++;
    return Promise.resolve();
  }
  if (pendingRenders.length >= 20 || pendingHtmlBytes + htmlBytes > 20 * 1024 * 1024) {
    return Promise.reject(renderFailed('PDF render queue is full (20 waiting jobs or 20 MB of queued HTML). The server is busy; retry the PDF render later.'));
  }
  return new Promise((resolve, reject) => {
    const job = { resolve, reject, htmlBytes, deadline: Date.now() + 60000 };
    job.timer = setTimeout(() => {
      pendingRenders.splice(pendingRenders.indexOf(job), 1);
      pendingHtmlBytes -= job.htmlBytes;
      reject(queueWaitError());
    }, 60000);
    pendingHtmlBytes += htmlBytes;
    pendingRenders.push(job);
  });
}

function releaseRender() {
  let next;
  while ((next = pendingRenders.shift())) {
    clearTimeout(next.timer);
    pendingHtmlBytes -= next.htmlBytes;
    if (Date.now() >= next.deadline) {
      next.reject(queueWaitError());
      continue;
    }
    next.resolve();
    return;
  }
  activeRenders--;
}

function isRefreshMeta(tag) {
  const attributes = /([^\t\n\f\r "'<>/=]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'=<>`]+)))?/g;
  for (const [, name, quoted, singleQuoted, unquoted] of tag.slice(5, -1).matchAll(attributes)) {
    if (name.toLowerCase() !== 'http-equiv') continue;
    const value = (quoted ?? singleQuoted ?? unquoted ?? '').replace(/&#(x[\da-f]+|\d+);?|&(Tab|NewLine);/gi, (_, numeric, named) => {
      if (named) return named.toLowerCase() === 'tab' ? '\t' : '\n';
      const code = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    });
    return value.trim().toLowerCase() === 'refresh';
  }
  return false;
}

function protectHtml(source) {
  const html = source.replace(/<!--(?:>|->|[\s\S]*?(?:--!?>|$))|<\/?[a-z][a-z\d:-]*(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>|<![^>]*>|<\?[^>]*>/gi, (tag) => {
    if (/^<base(?=[\t\n\f\r />])/i.test(tag)) return '';
    if (/^<meta(?=[\t\n\f\r />])/i.test(tag) && isRefreshMeta(tag)) return '';
    return tag;
  });
  // Untrusted templates may use inline CSS and data assets, but cannot run scripts or load external files or URLs.
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; script-src \'none\'; frame-src \'none\'; form-action \'none\'; base-uri \'none\'">';
  const prefix = html.match(/^[\t\n\f\r ]*(?:<!doctype[\t\n\f\r ]+html[\t\n\f\r ]*>[\t\n\f\r ]*)?(?:<html(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>[\t\n\f\r ]*)?/i)[0];
  const rest = html.slice(prefix.length);
  const head = rest.match(/^<head(?=[\t\n\f\r />])(?:[^"'<>]|"[^"]*"|'[^']*')*>/i);
  return head ? prefix + head[0] + policy + rest.slice(head[0].length)
    : `${prefix}<head>${policy}</head>${rest}`;
}

export function countPages(buffer) {
  const text = buffer.toString('latin1');
  const dictionaries = [];
  const stack = [];
  let offset = 0;
  for (const match of text.matchAll(/<<|>>/g)) {
    if (stack.length) stack[stack.length - 1].text += text.slice(offset, match.index);
    if (match[0] === '<<') stack.push({ text: '' });
    else if (stack.length) dictionaries.push(stack.pop().text);
    offset = match.index + 2;
  }
  const pageTrees = dictionaries.filter((dictionary) => /\/Type\s*\/Pages\b/.test(dictionary));
  const root = pageTrees.find((dictionary) => !/\/Parent\b/.test(dictionary));
  const count = root?.match(/\/Count\s+(\d+)\b/);
  if (count) return Number(count[1]);
  return dictionaries.filter((dictionary) => /\/Type\s*\/Page\b/.test(dictionary)).length;
}

export async function htmlToPdf(html, { chromeBin, docker = false, timeoutMs = 30000 } = {}) {
  const executable = chromeBin ?? findChrome();
  if (!isFile(executable)) {
    throw renderFailed('Chrome was not found for PDF rendering. Install Google Chrome or Chromium, or set CHROME_BIN to its executable path.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw renderFailed('PDF timeoutMs must be a positive number. Set timeoutMs to a positive duration in milliseconds.');
  }
  await acquireRender(Buffer.byteLength(html, 'utf8'));
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'jobforge-pdf-'));
    const input = join(directory, 'document.html');
    const output = join(directory, 'document.pdf');
    await writeFile(input, protectHtml(html), 'utf8');
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--no-first-run',
      '--disable-default-apps',
      '--disable-print-preview',
      '--no-pdf-header-footer',
      '--hide-scrollbars',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=2000',
      `--user-data-dir=${join(directory, 'chrome-profile')}`,
      `--print-to-pdf=${output}`
    ];
    if (docker || process.getuid?.() === 0) args.push('--no-sandbox', '--disable-dev-shm-usage');
    args.push(pathToFileURL(input).href);
    let failure;
    let stderr = '';
    try {
      ({ stderr } = await runFile(executable, args, {
        timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true
      }));
    } catch (error) {
      failure = error;
      stderr = error.stderr || '';
    }
    if (failure?.killed && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw renderFailed(`Chrome PDF rendering timed out after ${timeoutMs} ms. Simplify the HTML or increase timeoutMs and retry.`);
    }
    let pdf;
    try {
      pdf = await readFile(output);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!pdf?.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      const exit = failure?.signal ? `Chrome exited with signal ${failure.signal}. ` : '';
      const diagnostic = exit + (stderr.trim() || failure?.message || 'Chrome produced no PDF output.');
      throw renderFailed(`Chrome did not produce a valid PDF. Check CHROME_BIN and the HTML, then retry. ${diagnostic}`);
    }
    const pages = countPages(pdf);
    if (pages < 1) {
      throw renderFailed('Chrome PDF has no readable page tree. Check the HTML and Chrome installation, then retry.');
    }
    return { pdf, pages };
  } catch (error) {
    if (error.code === 'render_failed') throw error;
    throw renderFailed(`PDF rendering failed: ${error.message}. Check temporary-directory permissions and CHROME_BIN, then retry.`);
  } finally {
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } catch (error) {
      throw renderFailed(`Could not remove PDF temporary directory ${directory}: ${error.message}. Check its permissions and remove it before retrying.`);
    } finally {
      releaseRender();
    }
  }
}
