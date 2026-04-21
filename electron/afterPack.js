'use strict';

// electron-builder afterPack hook.
//
// Fixes `posix_spawnp failed` at runtime for node-pty in the packaged app:
//   1. Restore the +x bit on `spawn-helper` (stripped during packaging).
//   2. Ensure .node native modules are readable.
//   3. Strip the `com.apple.quarantine` xattr from the whole app bundle so
//      macOS Gatekeeper doesn't block spawn-helper from being exec'd.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function walk(dir, visit) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else if (entry.isFile()) {
      visit(full, entry.name);
    }
  }
}

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const isMac = process.platform === 'darwin';
  const appBundle = isMac ? path.join(appOutDir, `${appName}.app`) : appOutDir;
  const resourcesPath = isMac
    ? path.join(appBundle, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  const unpackedRoot = path.join(resourcesPath, 'app.asar.unpacked');

  console.log(`[afterPack] Scanning ${unpackedRoot}`);

  const helpers = [];
  const natives = [];
  walk(unpackedRoot, (full, name) => {
    if (name === 'spawn-helper') {
      fs.chmodSync(full, 0o755);
      helpers.push(full);
      console.log(`[afterPack] chmod 755 ${full}`);
    } else if (name.endsWith('.node')) {
      fs.chmodSync(full, 0o644);
      natives.push(full);
    }
  });
  console.log(`[afterPack] fixed ${helpers.length} spawn-helper, ${natives.length} .node files`);

  // chmod invalidates the ad-hoc signature macOS applied to prebuilt binaries
  // when they were unpacked; an unsigned exec fails with posix_spawnp error.
  // Re-sign them ad-hoc so macOS will let them run.
  if (isMac) {
    for (const file of [...helpers, ...natives]) {
      try {
        execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', file], { stdio: 'pipe' });
      } catch (err) {
        console.warn(`[afterPack] codesign failed on ${file}:`, err.message);
      }
    }
    console.log(`[afterPack] re-signed ${helpers.length + natives.length} binaries ad-hoc`);
  }

  // Strip ONLY the quarantine xattr (if present). We deliberately do NOT
  // run `xattr -cr` — that would also wipe the xattr-stored code-signing
  // resources (com.apple.cs.*), breaking the app's ad-hoc signatures and
  // causing `posix_spawn(POSIX_SPAWN_CLOEXEC_DEFAULT)` to fail with a
  // "code has no resources but signature indicates they must be present"
  // error from the kernel's spawn-time signature check.
  if (isMac) {
    try {
      execFileSync('/usr/bin/xattr', ['-rd', 'com.apple.quarantine', appBundle], { stdio: 'pipe' });
    } catch { /* no quarantine to remove — fine */ }

    // Re-sign the whole app bundle ad-hoc so every Mach-O inside carries a
    // coherent signature (our chmod on prebuilt helpers + .node files above
    // invalidated their ad-hoc signatures). `--deep` walks nested bundles
    // and frameworks; `--sign -` is the ad-hoc identity.
    try {
      execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle], { stdio: 'inherit' });
      console.log(`[afterPack] codesign --deep --sign - ${appBundle}`);
    } catch (err) {
      console.warn(`[afterPack] final codesign failed:`, err.message);
    }
  }
};
