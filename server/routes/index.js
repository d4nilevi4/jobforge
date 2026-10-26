import { register as registerMisc } from './misc.js';
import { register as registerProfile } from './profile.js';
import { register as registerTracks } from './tracks.js';
import { register as registerTemplates } from './templates.js';
import { register as registerApplications } from './applications.js';
import { register as registerBundle } from './bundle.js';

export function registerAll(router) {
  registerMisc(router);
  registerProfile(router);
  registerTracks(router);
  registerTemplates(router);
  registerApplications(router);
  registerBundle(router);
}
