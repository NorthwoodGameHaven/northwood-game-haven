// capacitor/scripts/patch-android.mjs — NGH-BUILD 2026-09-11a
// Run once after `npx cap add android` (npm run add:android does it for you).
// Adds verified App Links so https://gamehaven.guru/app/... (e.g. the Karaoke
// Battle join QR on the TVs) opens the app when it's installed, and asks for
// vibration (turn-tracker haptics) and the camera. Idempotent.
//
// NGH-BUILD 2026-09-12i: CAMERA was missing. site/app/karaoke/join.html and
// site/app/guru-specials.html both call navigator.mediaDevices.getUserMedia()
// to scan QR codes; in the packaged app that silently fails without the
// manifest permission, so "Scan" appeared to do nothing while the same page
// worked fine in a mobile browser. Both screens still accept a typed code, so
// the permission is optional — declared android:required="false" so the app
// stays installable on a device with no camera.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.resolve(HERE, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(MANIFEST)) { console.error('android project not found — run `npx cap add android` first'); process.exit(1); }
let xml = fs.readFileSync(MANIFEST, 'utf8');
const MARK = 'NGH-BUILD 2026-09-12i';
if (xml.includes(MARK)) { console.log('AndroidManifest already patched'); process.exit(0); }
const filter = `
            <!-- ${MARK}: verified App Links for gamehaven.guru/app/* -->
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="gamehaven.guru" android:pathPrefix="/app/" />
                <data android:scheme="https" android:host="gamehaven.guru" android:pathPrefix="/karaoke" />
                <data android:scheme="https" android:host="gamehaven.guru" android:pathPrefix="/turns" />
            </intent-filter>`;
const actEnd = xml.indexOf('</activity>');
if (actEnd < 0) { console.error('no </activity> in manifest'); process.exit(1); }
xml = xml.slice(0, actEnd) + filter + '\n        ' + xml.slice(actEnd);
const perms = [
  '<uses-permission android:name="android.permission.VIBRATE" />',
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />'
];
for (const p of perms) {
  const key = (p.match(/android:name="([^"]+)"/) || [])[1];
  if (key && !xml.includes(key)) xml = xml.replace('<application', p + '\n    <application');
}
fs.writeFileSync(MANIFEST, xml);
console.log('AndroidManifest patched (App Links + VIBRATE + CAMERA)');
