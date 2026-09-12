// NGH-BUILD 2026-09-11a
// --import this file to activate the karaoke/companion db stand-in hooks.
import { register } from 'node:module';
register('./_karaoke-hooks.mjs', import.meta.url);
