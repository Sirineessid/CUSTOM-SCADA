#!/usr/bin/env node
/**
 * custom-SCADA: configure, on a site "Accueil" view, three superimposed images whose
 * visibility follows a numeric tag (0 = stopped / 1 = running / 2 = fault), and color
 * the existing pump shape from the same tag with three ranges.
 *
 * Usage:
 *   node tools/apply-site-color-visibility.js --site <site-name> [--host http://127.0.0.1:1884]
 *                                              [--view Accueil] [--state-tag pompe1_etat_num]
 *                                              [--pump-item <id>] [--no-pump]
 *
 * The script is idempotent: running it twice replaces the objects it created.
 */

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
const stateTagName = args['state-tag'] || 'pompe1_etat_num';
const stateTagId = 't_' + stateTagName;
const pumpItemId = args['pump-item'] || 'SHE_c5123865-cf5f45d7';
const withPump = args['no-pump'] !== true;

const ITEM_IDS = {
    vert: 'OXC_pompe_etat_verte',
    bleu: 'OXC_pompe_etat_bleue',
    rouge: 'OXC_pompe_etat_rouge'
};
const COLORS = {
    vert: { fill: '#2E7D32', stroke: '#1B5E20', text: 'MARCHE', value: 1 },
    bleu: { fill: '#1976D2', stroke: '#0D47A1', text: 'ARRET', value: 0 },
    rouge: { fill: '#C62828', stroke: '#B71C1C', text: 'DEFAUT', value: 2 }
};

function svgFor(key) {
    const c = COLORS[key];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">\n` +
        ` <circle cx="60" cy="52" r="44" fill="${c.fill}" stroke="${c.stroke}" stroke-width="5"/>\n` +
        ` <circle cx="60" cy="52" r="18" fill="#FFFFFF" opacity="0.9"/>\n` +
        ` <path d="M60 34 L60 70 M42 52 L78 52" stroke="${c.stroke}" stroke-width="5"/>\n` +
        ` <rect x="10" y="92" width="100" height="24" rx="4" fill="${c.fill}" stroke="${c.stroke}"/>\n` +
        ` <text x="60" y="109" font-family="Arial" font-size="14" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${c.text}</text>\n` +
        `</svg>`;
}

async function request(path, options = {}) {
    const url = path.startsWith('http') ? path : base + path;
    const res = await fetch(url, options);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) throw new Error(`${options.method || 'GET'} ${url} -> ${res.status}: ${String(text).slice(0, 300)}`);
    return body;
}

const postJson = (path, data) => request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
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
            zoomTransform: false, zoomGainVariableId: '', zoomOffsetVariableId: '',
            zoomDisplay: '*', displayRange: false, rangeDynamic: false, rangeMin: 0,
            rangeMax: 65535, rangeMinVariableId: '', rangeMaxVariableId: '',
            highTextColor: '#000000', highBackgroundColor: '#ff0000',
            lowTextColor: '#000000', lowBackgroundColor: '#00ff00',
            ratioDisplay: false, ratioDynamic: false, ratioMin: 0, ratioMax: 65535,
            ratioMinVariableId: '', ratioMaxVariableId: ''
        },
        visibility: Object.assign({
            byBit: false, bitVariableId: '', bitShowWhen: 'on',
            byWord: true, wordVariableId: stateTagId, wordCondition: 'eq', wordValue: 0,
            penetration: false
        }, visibility)
    };
}

function imageItem(key, address, penetration) {
    const id = ITEM_IDS[key];
    const c = COLORS[key];
    return {
        id,
        type: 'svg-ext-own_ctrl-image',
        name: `pompe_etat_${key}`,
        property: {
            address,
            variableId: '',
            events: [],
            actions: [],
            ranges: [],
            style: defaultStyle({ wordValue: c.value, penetration })
        },
        label: 'HtmlImage',
        hide: false,
        lock: false
    };
}

function svgGroup(key, address, x, y) {
    const id = ITEM_IDS[key];
    const width = 110, height = 110;
    return `  <g id="${id}" type="svg-ext-own_ctrl-image" data-name="pompe_etat_${key}" ` +
        `data-custom="pompe-color-visibility" style="pointer-events:none" fill="#FFFFFF" stroke="#000000" ` +
        `stroke-width="0" font-size="14" font-family="sans-serif" text-anchor="middle">\n` +
        `   <rect stroke-width="0" x="${x}" y="${y}" width="${width}" height="${height}" id="svg_bg_${key}"/>\n` +
        `   <foreignObject x="${x}" y="${y}" width="${width}" height="${height}" id="H-${id}">\n` +
        `    <div xmlns="http://www.w3.org/1999/xhtml" id="D-${id}" style="width:100%;height:100%;"></div>\n` +
        `   </foreignObject>\n` +
        `  </g>\n`;
}

function removePrevious(svgcontent) {
    let out = svgcontent;
    // remove the groups created by a previous run
    out = out.replace(/[ \t]*<g\b[^>]*data-custom="pompe-color-visibility"[\s\S]*?<\/g>\n?/g, '');
    return out;
}

function injectGroups(svgcontent) {
    const marker = /(\s*)<\/g>\s*<\/svg>\s*$/;
    if (!marker.test(svgcontent)) throw new Error('Unable to find the closing SVG layer tag in the view');
    let groups = '';
    // the three images are strictly superimposed at the same position
    const x = 470, y = 545;
    groups += svgGroup('bleu', '', x, y);
    groups += svgGroup('vert', '', x, y);
    groups += svgGroup('rouge', '', x, y);
    return svgcontent.replace(marker, (m, sp) => sp + groups + sp + '</g></svg>');
}

async function main() {
    console.log(`Site: ${site}  ->  ${base}`);
    const project = await request('/api/project');
    const hmi = project.hmi || {};
    const meta = (hmi.views || []).find(v => v.name === viewName);
    if (!meta) throw new Error(`View "${viewName}" not found in site "${site}"`);
    const view = await request(`/api/project/view/${encodeURIComponent(meta.id)}`);
    console.log(`View: ${view.name} (${view.id})`);

    // 1) state tag on the FUXA Server device
    const device = Object.values(project.devices || {}).find(d => d.type === 'FuxaServer');
    if (!device) throw new Error('FUXA Server device not found');
    if (!device.tags[stateTagId]) {
        const template = device.tags['t_pompe1_etat'] || {
            id: stateTagId, name: stateTagName, type: 'boolean', init: '0', daq: {}
        };
        device.tags[stateTagId] = {
            ...template,
            id: stateTagId,
            name: stateTagName,
            type: 'number',
            value: 0,
            init: '0',
            description: 'Etat pompe 1: 0=arrêt, 1=marche, 2=défaut (couleur/visibilité)'
        };
        await postJson('/api/projectData', { cmd: 'set-device', data: device });
        console.log(`Tag created: ${stateTagId} (number, 0/1/2)`);
    } else {
        console.log(`Tag already present: ${stateTagId}`);
    }

    // 2) upload the three colored images
    const addresses = {};
    for (const key of Object.keys(ITEM_IDS)) {
        const fileName = `pompe_etat_${key}.svg`;
        const result = await postJson('/api/upload', {
            resource: { type: 'svg', name: fileName, data: svgFor(key) }
        });
        addresses[key] = result.location;
        console.log(`Image uploaded: ${fileName} -> ${result.location}`);
    }

    // 3) update the view: items + SVG + ranges of the pump shape
    const items = view.items || (view.items = {});
    for (const id of Object.values(ITEM_IDS)) delete items[id];
    items[ITEM_IDS.bleu] = imageItem('bleu', addresses.bleu, false);
    items[ITEM_IDS.vert] = imageItem('vert', addresses.vert, true);
    items[ITEM_IDS.rouge] = imageItem('rouge', addresses.rouge, true);

    if (withPump && items[pumpItemId]) {
        items[pumpItemId].property = items[pumpItemId].property || {};
        items[pumpItemId].property.variableId = stateTagId;
        items[pumpItemId].property.ranges = [
            { min: 0, max: 0, color: '#1976D2', stroke: '#0D47A1' },
            { min: 1, max: 1, color: '#2E7D32', stroke: '#1B5E20' },
            { min: 2, max: 2, color: '#C62828', stroke: '#B71C1C' }
        ];
        console.log(`Pump shape ${pumpItemId}: 3 ranges on ${stateTagId}`);
    }

    view.svgcontent = injectGroups(removePrevious(view.svgcontent || ''));
    await postJson('/api/projectData', { cmd: 'set-view', data: view });
    console.log('View saved.');

    // 4) verification
    const saved = await request(`/api/project/view/${encodeURIComponent(view.id)}`);
    for (const id of Object.values(ITEM_IDS)) {
        if (!saved.items[id]) throw new Error(`Missing item ${id} after save`);
    }
    const generated = await request('/fichiers/' + viewName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') + '.html');
    const html = typeof generated === 'string' ? generated : '';
    console.log(`Verification: ${Object.values(ITEM_IDS).length} image objects in view; generated page contains them: ${html.includes(ITEM_IDS.vert)}`);
    console.log('Done. Open ' + base + '/home/' + encodeURIComponent(viewName));
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
