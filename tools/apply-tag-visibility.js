#!/usr/bin/env node
/**
 * custom-SCADA: add a tag-driven Visibility property to an existing object OR to a newly
 * imported image of a site view.
 *
 * Boolean rule: tag False/OFF -> object hidden, tag True/ON -> object visible
 *               (or the opposite with --show-when off).
 *
 * Usage:
 *   node tools/apply-tag-visibility.js --site test --tag t_visibility_test \
 *        --item SHE_c5123865-cf5f45d7
 *   node tools/apply-tag-visibility.js --site test --tag t_visibility_test \
 *        --image C:\images\mon_image.png --name mon_image --x 100 --y 100 --w 120 --h 120
 *
 * Options: --view Accueil, --show-when on|off, --penetration, --create-tag, --host ...
 * Always call with --create-tag once if the tag does not exist yet in the site.
 */
const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i] ?? true;
}
const site = args.site;
if (!site) { console.error('Missing --site <name>'); process.exit(1); }
const host = (args.host || 'http://127.0.0.1:1884').replace(/\/+$/, '');
const base = `${host}/site/${encodeURIComponent(site)}`;
const viewName = args.view || 'Accueil';
const tagId = args.tag || 't_visibility_test';
const showWhen = args['show-when'] === 'off' ? 'off' : 'on';
const penetration = args.penetration === true;

async function request(urlPath, options = {}) {
    const res = await fetch(urlPath.startsWith('http') ? urlPath : base + urlPath, options);
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) throw new Error(`${options.method || 'GET'} ${urlPath} -> ${res.status}: ${String(text).slice(0, 250)}`);
    return body;
}
const postJson = (p, data) => request(p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
});

function defaultStyle(visibility) {
    return {
        general: {
            borderColor: '#0000ff', foreground: '#000000', background: '#ffff00',
            pattern: 'none', dataType: 'float32', totalDigits: 5,
            fractionalDigits: 2, zeroPadding: false
        },
        label: {
            text: '888.88', fontFamily: 'Arial', fontSize: 16, bold: false,
            italic: false, underline: false, color: '#000000', wordSpacing: 0,
            position: 'center', image: ''
        },
        advanced: {
            zoom: false, zoomMode: 'gain', zoomFormula: '', zoomGain: 1, zoomOffset: 0,
            zoomTransform: false, zoomGainVariableId: '', zoomOffsetVariableId: '', zoomDisplay: '*',
            displayRange: false, rangeDynamic: false, rangeMin: 0, rangeMax: 65535,
            rangeMinVariableId: '', rangeMaxVariableId: '',
            highTextColor: '#000000', highBackgroundColor: '#ff0000',
            lowTextColor: '#000000', lowBackgroundColor: '#00ff00',
            ratioDisplay: false, ratioDynamic: false, ratioMin: 0, ratioMax: 65535,
            ratioMinVariableId: '', ratioMaxVariableId: ''
        },
        visibility: Object.assign({
            byBit: true, bitVariableId: tagId, bitShowWhen: showWhen,
            byWord: false, wordVariableId: '', wordCondition: 'eq', wordValue: 0,
            penetration
        }, visibility)
    };
}

function setVisibility(item) {
    item.property = item.property || {};
    item.property.events = item.property.events || [];
    item.property.actions = item.property.actions || [];
    const current = item.property.style || {};
    item.property.style = {
        ...defaultStyle({}), ...current,
        visibility: {
            byBit: true, bitVariableId: tagId, bitShowWhen: showWhen,
            byWord: false, wordVariableId: '', wordCondition: 'eq', wordValue: 0,
            penetration
        }
    };
}

function svgGroupFor(id, name, x, y, w, h) {
    return `  <g id="${id}" type="svg-ext-own_ctrl-image" data-name="${name}" ` +
        `data-custom="tag-visibility-${id}" style="pointer-events:none" fill="#FFFFFF" stroke="#000000" ` +
        `stroke-width="0" font-size="14" font-family="sans-serif" text-anchor="middle">\n` +
        `   <rect stroke-width="0" x="${x}" y="${y}" width="${w}" height="${h}" id="svg_${id}"/>\n` +
        `   <foreignObject x="${x}" y="${y}" width="${w}" height="${h}" id="H-${id}">\n` +
        `    <div xmlns="http://www.w3.org/1999/xhtml" id="D-${id}" style="width:100%;height:100%;"></div>\n` +
        `   </foreignObject>\n` +
        `  </g>\n`;
}

async function ensureTag(project) {
    const device = Object.values(project.devices || {}).find(d => d.type === 'FuxaServer');
    if (!device) throw new Error('FUXA Server device not found');
    if (device.tags[tagId]) { console.log(`Tag already present: ${tagId}`); return; }
    const tpl = device.tags['t_pompe1_etat'] || { daq: {} };
    device.tags[tagId] = {
        ...tpl, id: tagId, name: tagId.replace(/^t_/, ''), type: 'boolean',
        value: false, init: '0',
        description: 'Visibilité (False = masqué, True = visible)'
    };
    await postJson('/api/projectData', { cmd: 'set-device', data: device });
    console.log(`Boolean tag created: ${tagId}`);
}

async function main() {
    const project = await request('/api/project');
    const meta = (project.hmi?.views || []).find(v => v.name === viewName);
    if (!meta) throw new Error(`View "${viewName}" not found`);
    // always work on a fresh full view (not on a project snapshot that may be cached)
    const view = await request(`/api/project/view/${encodeURIComponent(meta.id)}`);
    if (!args['create-tag'] && !Object.values(project.devices || {}).some(d => d.tags?.[tagId])) {
        throw new Error(`Tag ${tagId} missing. Add --create-tag to create it.`);
    }
    if (args['create-tag']) await ensureTag(project);

    const items = view.items || (view.items = {});
    const cleanSvg = (view.svgcontent || '').replace(new RegExp(`[ \\t]*<g\\b[^>]*data-custom="tag-visibility-[^"]*"[\\s\\S]*?</g>\\n?`, 'g'), '');
    let addedGroup = '';

    if (args.item) {
        if (!items[args.item]) throw new Error(`Item ${args.item} not found in view ${viewName}`);
        setVisibility(items[args.item]);
        console.log(`Visibility added to existing object: ${args.item} (${items[args.item].name || ''})`);
    }

    if (args.image) {
        const filePath = path.resolve(String(args.image));
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const name = args.name || path.basename(filePath, path.extname(filePath));
        const id = 'OXC_' + name.replace(/[^A-Za-z0-9_-]/g, '_');
        const data = ext === 'svg'
            ? fs.readFileSync(filePath, 'utf8')
            : 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + fs.readFileSync(filePath).toString('base64');
        const uploaded = await postJson('/api/upload', {
            resource: { type: ext, name: `${name}.${ext}`, data }
        });
        const x = Number(args.x || 100), y = Number(args.y || 100);
        const w = Number(args.w || 120), h = Number(args.h || 120);
        items[id] = {
            id, type: 'svg-ext-own_ctrl-image', name,
            property: { address: uploaded.location, events: [], actions: [], ranges: [] },
            label: 'HtmlImage', hide: false, lock: false
        };
        setVisibility(items[id]);
        addedGroup = svgGroupFor(id, name, x, y, w, h);
        console.log(`Image imported: ${filePath} -> ${uploaded.location} as ${id}`);
    }

    if (!args.item && !args.image) throw new Error('Provide --item <id> and/or --image <file>');

    const marker = /(\s*)<\/g>\s*<\/svg>\s*$/;
    if (addedGroup && !marker.test(cleanSvg)) throw new Error('Cannot find SVG layer closing tag');
    view.svgcontent = addedGroup
        ? cleanSvg.replace(marker, (m, sp) => sp + addedGroup + sp + '</g></svg>')
        : cleanSvg;

    await postJson('/api/projectData', { cmd: 'set-view', data: view });
    const saved = await request(`/api/project/view/${encodeURIComponent(view.id)}`);
    const targets = [args.item, args.image ? 'OXC_' + String(args.name || path.basename(String(args.image), path.extname(String(args.image)))).replace(/[^A-Za-z0-9_-]/g, '_') : null].filter(Boolean);
    for (const id of targets) {
        const v = saved.items[id]?.property?.style?.visibility;
        if (!v || v.bitVariableId !== tagId || v.bitShowWhen !== showWhen) throw new Error(`Visibility check failed for ${id}`);
    }
    console.log(`Saved. Visibility = ${showWhen === 'on' ? 'visible when True, hidden when False' : 'visible when False, hidden when True'}.`);
    console.log(`Open ${base}/home/${encodeURIComponent(viewName)}`);
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
