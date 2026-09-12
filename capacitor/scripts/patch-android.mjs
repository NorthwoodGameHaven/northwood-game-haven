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
const MARK = 'NGH-BUILD 2026-09-12m';
// Do NOT exit here on a re-run: the version stamp at the bottom of this file
// still has to run, and skipping it would silently ship an unbumped
// versionCode that Play rejects only after the upload completes.
const manifestDone = xml.includes(MARK);
if (manifestDone) console.log('AndroidManifest already patched');
if (!manifestDone) {
const filter = `
            <!-- ${MARK}: verified App Links for gamehaven.guru/app/* -->
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="gamehaven.guru" android:pathPrefix="/app/" />
                <data android:scheme="https" android:host="gamehaven.guru" android:pathPrefix="/karaoke" />
                <data android:scheme="https" android:host="gamehaven.guru" android:pathPrefix="/turns" />
                <!-- NGH-BUILD 2026-09-12m: the Speed Gaming and Magic night TV QRs -->
                <data android:scheme="https" android:host="gamehaven.guru" android:pathPrefix="/speedgaming" />
                <data android:scheme="https" android:host="gamehaven.guru" android:pathPrefix="/mtg" />
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

}   // end manifest patch

// ---- NGH-BUILD 2026-09-12m: app version -----------------------------------------
// Google Play refuses any upload whose versionCode is not HIGHER than the last
// one, and the error arrives after the upload finishes — so getting this wrong
// costs a full build cycle. Capacitor's generated build.gradle hardcodes
// versionCode 1, which means the second release upload would always be
// rejected. Derive both from ONE place: the version in capacitor/package.json.
//
//   1.0.0 -> versionCode 10000, versionName "1.0.0"
//   1.0.1 -> versionCode 10001
//   1.2.0 -> versionCode 10200
//
// So the only thing to remember before a Play upload is: bump the version in
// capacitor/package.json.
const GRADLE = path.resolve(HERE, '..', 'android', 'app', 'build.gradle');
if (fs.existsSync(GRADLE)) {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(pkg.version || '1.0.0'));
  if (!m) { console.error('capacitor/package.json version must look like 1.2.3, got ' + pkg.version); process.exit(1); }
  const code = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  let g = fs.readFileSync(GRADLE, 'utf8');
  // Check that the fields EXIST separately from whether they CHANGED. Warning
  // "could not find versionCode" simply because it was already correct trains
  // everyone to ignore the build log, which is how the real warning gets missed.
  const hasCode = /versionCode\s+\d+/.test(g);
  const hasName = /versionName\s+"[^"]*"/.test(g);
  if (!hasCode || !hasName) {
    console.error('ERROR: build.gradle has no ' + (!hasCode ? 'versionCode' : 'versionName') +
      ' to stamp. Play will reject the upload — fix build.gradle before building a release.');
    process.exit(1);
  }
  const before = g;
  g = g.replace(/versionCode\s+\d+/, 'versionCode ' + code);
  g = g.replace(/versionName\s+"[^"]*"/, 'versionName "' + pkg.version + '"');
  if (g !== before) {
    fs.writeFileSync(GRADLE, g);
    console.log('set versionCode ' + code + ' / versionName ' + pkg.version + ' from package.json');
  } else {
    console.log('versionCode ' + code + ' / versionName ' + pkg.version + ' already correct');
  }
} else {
  console.warn('build.gradle not found — skipping version stamp');
}
