import { renderFailed } from '../errors.js';
import { renderTemplate } from './engine.js';
import { htmlToPdf } from './pdf.js';

export function renderHtml({ meta, source, context }) {
  try {
    return renderTemplate(source, context);
  } catch (error) {
    throw renderFailed(`Template ${meta?.id || '(unnamed)'} could not render: ${error.message} Fix template.html and retry.`);
  }
}

export async function renderPdf({ meta, source, context, chrome }) {
  const html = renderHtml({ meta, source, context });
  const result = await htmlToPdf(html, typeof chrome === 'string' ? { chromeBin: chrome } : chrome);
  return { html, ...result };
}
