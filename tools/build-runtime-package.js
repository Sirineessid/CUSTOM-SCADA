#!/usr/bin/env node
/**
 * custom-SCADA: build a runtime-only FUXA package (no source code, no tests,
 * no tools, no git history, no runtime data). The target only needs Node.js,
 * `npm ci --omit=dev` in server/, and the deployment agent to receive site releases.
 *
 * Usage: node tools/build-runtime-package.js [--source <repo>] [--out <zip>]
 */
const fs = require('fs');
const path = require('path');
const zip = require('../server/runtime/sites/zip.js');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i] ?? true;
}
const source = path.resolve(args.source || path.join(__dirname, '..'));
const out = path.resolve(args.out || path.join(source, 'dist-release', 'fuxa-runtime-only.zip'));
const ROOT = 'fuxa-runtime';

const SERVER_FILES = [
    'main.js', 'fuxa.js', 'paths.js', 'settings.default.js', 'envParams.js',
    'package.json', 'package-lock.json', 'project.default.json', 'project.demo.fuxap'
];
const SERVER_DIRS = [
    'api', 'runtime', 'integrations', 'templates', 'docs',
    'deployment-agent', '_images', '_widgets', 'dist'
];
const SKIP_IN_DIRS = new Set(['node_modules', '_appdata', '_db', '_logs', '_upload_files', '_reports', '_pkg']);

const entries = [];

function addFile(srcRel, zipRel) {
    const full = path.join(source, srcRel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return;
    entries.push({
        name: `${ROOT}/${zipRel.replace(/\\/g, '/')}`,
        data: fs.readFileSync(full),
        date: fs.statSync(full).mtime
    });
}

function addDir(srcRel, zipRel) {
    const full = path.join(source, srcRel);
    if (!fs.existsSync(full)) return;
    const walk = (dir, currentRel) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (SKIP_IN_DIRS.has(e.name)) continue;
            const rel = path.join(currentRel, e.name);
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) walk(abs, rel);
            else if (e.isFile()) addFile(path.relative(source, abs), rel);
        }
    };
    walk(full, zipRel);
}

for (const f of SERVER_FILES) addFile(path.join('server', f), path.join('server', f));
for (const d of SERVER_DIRS) addDir(path.join('server', d), path.join('server', d));
addDir('client/dist', 'client/dist');

const buffer = zip.create(entries);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buffer);

const dirs = [...new Set(entries.map(e => e.name.split('/').slice(1, 3).join('/')))].sort();
console.log(`Runtime package: ${out}`);
console.log(`Files: ${entries.length}  Size: ${(buffer.length / 1048576).toFixed(2)} MB`);
console.log('Top-level content:\n  ' + dirs.join('\n  '));
console.log('Excluded: client/src, client/e2e, client/test, tools/, snapshots/, .git/, node_modules/ and all runtime data.');
