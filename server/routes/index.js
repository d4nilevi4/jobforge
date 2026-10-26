import { register as registerMisc } from './misc.js';
import { register as registerProfile } from './profile.js';
import { register as registerTracks } from './tracks.js';
import { register as registerTemplates } from './templates.js';

export function registerAll(router) {
  registerMisc(router);
  registerProfile(router);
  registerTracks(router);
  registerTemplates(router);
}
