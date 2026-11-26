/**
 * custom-SCADA: notifications of the alarms by Telegram (free bot), made by the main FUXA for all the sites
 *
 * - every 10 s the active alarms of each started site are read (GET /api/v1/alarms of the site: thresholds, scenarios, communication)
 * - a new alarm (or the end of an alarm, if asked) is sent to the Telegram chats of the rules that match it (sites, priorities, sources)
 * - the alarms of the same chat are grouped in one message (delay of grouping), to avoid many messages at once
 * - the alarms already active when the main FUXA starts are not sent (they were sent before the restart)
 * - bot: made with @BotFather in Telegram (token); chat: id of a user or of a group (negative), or @channel;
 *   a user must open the bot and press Start once before the bot can write to him
 * - sites/_notifications/config.json (settings), envois.jsonl (log of the messages sent or failed)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const accounts = require('./accounts');

const LEVELS = ['highhigh', 'high', 'low', 'info'];
const LEVEL_TEXT = { highhigh: 'Critique', high: 'Haute', low: 'Basse', info: 'Information' };
const SOURCES = ['alarme', 'scenario', 'communication'];
const CHAT = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/;
const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{20,80}$/;
const MASK = '********';
const POLL = 10000;
const MAX_LOG = 2000;
// address of the Telegram API (another address only for the tests)
const API = process.env.SCADA_TELEGRAM_API || 'https://api.telegram.org';

let dir = null, logger = null, manager = null, config = null, timer = null;
let known = {};          // site -> { key: alarm } alarms active at the last reading
let ready = {};          // site -> true when the first reading was made (the alarms present then are not sent)
let queue = [];          // { rule, site, alarm, kind: 'debut' | 'fin' } waiting for the grouping
let flushTimer = null;
let lastPoll = { time: 0, sites: {} };

function httpError(status, code, message, details) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    err.details = details;
    return err;
}

function defaults() {
    return { enabled: false, groupDelay: 30, prefix: '[SCADA]', telegram: { token: '' }, rules: [] };
}

/**
 * @param _manager { names(), get(name) -> site, request(site, method, path) }
 */
function init(sitesDir, _manager, _logger) {
    dir = path.join(sitesDir, '_notifications');
    manager = _manager;
    logger = _logger;
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    config = defaults();
    try {
        const file = path.join(dir, 'config.json');
        if (fs.existsSync(file)) {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            // only the Telegram settings are kept (the email version had smtp, mode, emails as recipients)
            config = {
                enabled: !!saved.enabled, groupDelay: Number.isFinite(saved.groupDelay) ? saved.groupDelay : 30,
                prefix: saved.prefix !== undefined ? String(saved.prefix) : defaults().prefix,
                telegram: { token: (saved.telegram && saved.telegram.token) || '' },
                rules: (saved.rules || []).map(r => ({ id: r.id, name: r.name, enabled: r.enabled, sites: r.sites || [], levels: r.levels || [], sources: r.sources || [],
                    recipients: (r.recipients || []).filter(c => CHAT.test(c)), onEnd: !!r.onEnd }))
            };
            if (config.enabled && !config.telegram.token) { config.enabled = false; }
        }
    } catch (err) {
        logger.error(`notifications: config.json invalide (${err.message})`);
    }
    clearInterval(timer);
    timer = setInterval(() => poll().catch(err => logger.error(`notifications: ${err.message}`)), POLL);
    setTimeout(() => poll().catch(() => { /* next time */ }), 5000);
}

// ---------------------------------------------------------------- settings
function cleanChats(list, field) {
    const values = (Array.isArray(list) ? list : String(list || '').split(/[,;\s]+/)).map(e => String(e).trim()).filter(Boolean);
    const bad = values.filter(e => !CHAT.test(e));
    if (bad.length) {
        throw httpError(400, 'invalid_request', `Chat Telegram invalide : ${bad.join(', ')} (identifiant numérique, négatif pour un groupe, ou @canal).`, { field });
    }
    return Array.from(new Set(values)).slice(0, 50);
}

function cleanRules(list) {
    if (!Array.isArray(list) || list.length > 50) {
        throw httpError(400, 'invalid_request', 'Liste des règles invalide (50 au plus).', { field: 'rules' });
    }
    const names = manager.names();
    return list.map((r, i) => {
        const name = String(r.name || '').trim().slice(0, 100) || `Règle ${i + 1}`;
        const sites = (Array.isArray(r.sites) ? r.sites : []).map(String);
        const unknown = sites.filter(s => !names.includes(s));
        if (unknown.length) {
            throw httpError(400, 'invalid_request', `${name} : site inconnu (${unknown.join(', ')}).`, { index: i, field: 'sites' });
        }
        const levels = (Array.isArray(r.levels) ? r.levels : LEVELS).filter(l => LEVELS.includes(l));
        const sources = (Array.isArray(r.sources) ? r.sources : SOURCES).filter(s => SOURCES.includes(s));
        if (!levels.length || !sources.length) {
            throw httpError(400, 'invalid_request', `${name} : au moins une priorité et une source.`, { index: i, field: 'levels' });
        }
        const recipients = cleanChats(r.recipients, 'recipients');
        if (!recipients.length) {
            throw httpError(400, 'invalid_request', `${name} : aucun chat Telegram.`, { index: i, field: 'recipients' });
        }
        return {
            id: /^[A-Za-z0-9_-]{1,40}$/.test(r.id || '') ? r.id : `n${Date.now().toString(36)}${i}`,
            name, enabled: r.enabled !== false, sites, levels, sources, recipients, onEnd: !!r.onEnd
        };
    });
}

function getConfig() {
    const c = JSON.parse(JSON.stringify(config));
    c.telegram.hasToken = !!config.telegram.token;
    c.telegram.token = config.telegram.token ? MASK : '';
    return c;
}

function setConfig(input, by) {
    const next = JSON.parse(JSON.stringify(config));
    if (input.enabled !== undefined) { next.enabled = !!input.enabled; }
    if (input.groupDelay !== undefined) {
        const d = Number(input.groupDelay);
        if (!Number.isFinite(d) || d < 0 || d > 3600) {
            throw httpError(400, 'invalid_request', 'Délai de regroupement invalide (0 à 3600 s).', { field: 'groupDelay' });
        }
        next.groupDelay = d;
    }
    if (input.prefix !== undefined) { next.prefix = String(input.prefix).slice(0, 40); }
    // the token is shown masked: unchanged when the mask comes back
    if (input.telegram && input.telegram.token !== undefined && input.telegram.token !== MASK) {
        const token = String(input.telegram.token).trim();
        if (token && !TOKEN.test(token)) {
            throw httpError(400, 'invalid_request', 'Jeton du bot Telegram invalide (format 123456789:ABC..., donné par @BotFather).', { field: 'telegram.token' });
        }
        next.telegram.token = token;
    }
    if (input.rules !== undefined) { next.rules = cleanRules(input.rules); }
    if (next.enabled && !next.telegram.token) {
        throw httpError(400, 'invalid_request', 'Jeton du bot Telegram manquant.', { field: 'telegram.token' });
    }
    config = next;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
    accounts.journal({ type: 'notifications', action: 'paramètres', user: by || null, result: 'ok', detail: `Notifications Telegram ${config.enabled ? 'activées' : 'désactivées'}, ${config.rules.length} règle(s)` });
    return getConfig();
}

// ---------------------------------------------------------------- reading of the alarms
const keyOf = a => `${a.alarm_id}|${a.type}|${a.ontime || ''}`;

async function poll() {
    const time = Date.now();
    const sites = {};
    for (const name of manager.names()) {
        const site = manager.get(name);
        if (!site || !site.running) {
            // a stopped site: read again from zero when it starts (its alarms then are not sent)
            delete known[name];
            delete ready[name];
            sites[name] = 'arrêté';
            continue;
        }
        let list;
        try {
            const answer = await manager.request(site, 'GET', '/api/v1/alarms');
            list = (answer && answer.data) || [];
            sites[name] = list.length;
        } catch (err) {
            sites[name] = `erreur : ${err.message}`;
            continue;
        }
        const now = {};
        list.forEach(a => { now[keyOf(a)] = a; });
        const before = known[name] || {};
        if (ready[name] && config.enabled) {
            Object.keys(now).filter(k => !before[k] && now[k].status !== 'NF').forEach(k => matchRules(name, now[k], 'debut'));
            Object.keys(before).filter(k => before[k].status !== 'NF' && (!now[k] || now[k].status === 'NF')).forEach(k => matchRules(name, now[k] || before[k], 'fin'));
        }
        known[name] = now;
        ready[name] = true;
    }
    lastPoll = { time, sites };
}

function matchRules(site, alarm, kind) {
    config.rules.filter(r => r.enabled &&
        (!r.sites.length || r.sites.includes(site)) &&
        r.levels.includes(alarm.type) &&
        r.sources.includes(alarm.source || 'alarme') &&
        (kind === 'debut' || r.onEnd)
    ).forEach(rule => queue.push({ rule, site, alarm, kind, time: Date.now() }));
    if (queue.length && !flushTimer) {
        flushTimer = setTimeout(() => { flushTimer = null; flush().catch(err => logger.error(`notifications: ${err.message}`)); }, config.groupDelay * 1000);
    }
}

// ---------------------------------------------------------------- messages
function esc(t) {
    return String(t === null || t === undefined ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function dateText(ms) {
    if (!ms) { return ''; }
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** one message per chat with all the alarms of the queue for it */
async function flush() {
    const items = queue;
    queue = [];
    const byChat = {};
    items.forEach(item => {
        item.rule.recipients.forEach(chat => {
            const list = byChat[chat] = byChat[chat] || [];
            // the same alarm by two rules: once
            if (!list.some(x => x.site === item.site && x.kind === item.kind && keyOf(x.alarm) === keyOf(item.alarm))) {
                list.push(item);
            }
        });
    });
    for (const chat of Object.keys(byChat)) {
        await send(chat, byChat[chat]);
    }
}

/** title of the message (also kept in the log) */
function title(items) {
    if (items.length === 1) {
        const i = items[0];
        return `${i.kind === 'fin' ? 'Fin d’alarme' : 'Alarme ' + (LEVEL_TEXT[i.alarm.type] || '').toLowerCase()} - ${i.site} - ${i.alarm.text}`;
    }
    const starts = items.filter(i => i.kind === 'debut');
    const critical = starts.filter(i => i.alarm.type === 'highhigh').length;
    const sites = Array.from(new Set(items.map(i => i.site)));
    return `${starts.length} nouvelle(s) alarme(s)${critical ? ` dont ${critical} critique(s)` : ''}${items.length > starts.length ? `, ${items.length - starts.length} fin(s)` : ''} - ${sites.join(', ')}`;
}

/** Telegram message (HTML): title, then one block per alarm */
function compose(items) {
    const icon = { highhigh: '🔴', high: '🟠', low: '🟡', info: '🔵' };
    const blocks = items.map(i => {
        const a = i.alarm;
        const value = a.value !== null && a.value !== undefined && a.value !== '' ? ` · valeur : ${esc(a.value)}` : '';
        return `${i.kind === 'fin' ? '✅' : icon[a.type] || '⚪'} <b>${esc(i.site)}</b> · ${esc(LEVEL_TEXT[a.type] || a.type)} · ${i.kind === 'fin' ? 'Fin' : 'Début'} ` +
            `${esc(dateText(i.kind === 'fin' ? (a.offtime || i.time) : a.ontime))}\n${esc(a.text)}${a.device ? `\nÉquipement : ${esc(a.device)}` : ''}${value}`;
    });
    // shortcut: a group longer than the Telegram limit (4096 characters) is cut; split in several messages if it happens
    return `${config.prefix ? esc(config.prefix) + ' ' : ''}<b>${esc(title(items))}</b>\n\n${blocks.join('\n\n')}`.slice(0, 4000);
}

function log(entry) {
    const file = path.join(dir, 'envois.jsonl');
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    try {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        if (lines.length > MAX_LOG * 1.2) {
            fs.writeFileSync(file, lines.slice(-MAX_LOG).join('\n') + '\n');
        }
    } catch (err) { /* log kept */ }
}

async function send(chat, items, test) {
    const text = test ? `${config.prefix ? esc(config.prefix) + ' ' : ''}<b>Message de test</b>\nLes notifications des alarmes de custom-SCADA fonctionnent.` : compose(items);
    const entry = {
        time: Date.now(), to: chat, subject: test ? 'Message de test' : title(items), test: !!test,
        count: items.length, sites: Array.from(new Set(items.map(i => i.site))), status: 'envoyé', error: null
    };
    try {
        const r = await fetch(`${API}/bot${config.telegram.token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
            body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true })
        });
        const answer = await r.json().catch(() => ({}));
        if (!answer.ok) {
            throw new Error(answer.description || `réponse ${r.status}`);
        }
    } catch (err) {
        entry.status = 'échec';
        // the error of fetch can contain the address, and the address the token
        entry.error = String(err.message).split(config.telegram.token).join(MASK);
        logger.error(`notifications: Telegram message to ${chat} failed (${entry.error})`);
    }
    log(entry);
    return entry;
}

async function test(to, by) {
    if (!config.telegram.token) {
        throw httpError(400, 'invalid_request', 'Jeton du bot Telegram manquant.', { field: 'telegram.token' });
    }
    const list = cleanChats(to, 'to');
    if (!list.length) {
        throw httpError(400, 'invalid_request', 'Chat Telegram du destinataire manquant.', { field: 'to' });
    }
    const results = [];
    for (const chat of list) {
        results.push(await send(chat, [], true));
    }
    accounts.journal({ type: 'notifications', action: 'message de test', user: by || null, result: 'ok', detail: `Message Telegram de test vers ${list.join(', ')}` });
    return results;
}

function history(limit) {
    const file = path.join(dir, 'envois.jsonl');
    if (!fs.existsSync(file)) { return []; }
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter(Boolean).reverse().slice(0, limit || 200);
}

function status() {
    return { enabled: config.enabled, rules: config.rules.filter(r => r.enabled).length, waiting: queue.length, lastPoll };
}

module.exports = { init, getConfig, setConfig, test, history, status, LEVELS, SOURCES, _poll: poll, _flush: flush };
