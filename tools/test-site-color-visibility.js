#!/usr/bin/env node
/**
 * custom-SCADA: test helper. Pushes a value (0 = stopped, 1 = running, 2 = fault) into a
 * numeric tag of a site and prints the resulting value read back through the site API.
 * Uses only Node's built-in WebSocket (Node 22+).
 *
 * Usage:
 *   node tools/test-site-color-visibility.js --site test --value 1
 *   node tools/test-site-color-visibility.js --site test --tag t_pompe1_etat_num --value 2
 */
const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i] ?? true;
}
const site = args.site || 'test';
const raw = String(args.value ?? '');
const value = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
const tag = args.tag || 't_pompe1_etat_num';
const host = (args.host || 'http://127.0.0.1:1884').replace(/\/+$/, '');
if (!Number.isFinite(value) && typeof value !== 'boolean') { console.error('Missing or invalid --value (0|1|2|true|false)'); process.exit(1); }

const wsUrl = host.replace(/^http/, 'ws') + `/site/${encodeURIComponent(site)}/socket.io/?EIO=4&transport=websocket`;
const ws = new WebSocket(wsUrl);

ws.onmessage = async (e) => {
    const msg = String(e.data);
    if (msg.startsWith('0')) { ws.send('40'); return; }         // Engine.IO open -> Socket.IO connect
    if (msg.startsWith('40')) {                                  // connected to the namespace
        ws.send('42' + JSON.stringify(['device-values', { cmd: 'set', var: { source: '0', id: tag, value } }]));
        setTimeout(async () => {
            try {
                const r = await fetch(`${host}/api/v1/sites/${encodeURIComponent(site)}/values`);
                const j = await r.json();
                const current = (j.data || []).find(t => t.id === tag);
                console.log(`${tag} = ${current ? current.value : '(not found)'}`);
            } catch (err) { console.error('read back failed:', err.message); }
            ws.close();
            process.exit(0);
        }, 800);
    }
};
ws.onerror = (e) => { console.error('WebSocket error:', e.message || e); process.exit(1); };
