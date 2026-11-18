/**
 * custom-SCADA: notifications of the alarms by email, made by the main FUXA for all the sites
 *
 * - every 10 s the active alarms of each started site are read (GET /api/v1/alarms of the site: thresholds, scenarios, communication)
 * - a new alarm (or the end of an alarm, if asked) is sent to the recipients of the rules that match it (sites, priorities, sources)
 * - the alarms of the same recipients are grouped in one email (delay of grouping), to avoid many emails at once
 * - the alarms already active when the main FUXA starts are not sent (they were sent before the restart)
 * - recipients: emails written in the rule, and/or the emails of the accounts that can open the site (central accounts)
 * - sending: SMTP server (nodemailer), or test mode: the emails are written in sites/_notifications/envoyes/*.eml
 * - sites/_notifications/config.json (settings), envois.jsonl (log of the emails sent or failed)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const accounts = require('./accounts');

const LEVELS = ['highhigh', 'high', 'low', 'info'];
const LEVEL_TEXT = { highhigh: 'Critique', high: 'Haute', low: 'Basse', info: 'Information' };
const SOURCES = ['alarme', 'scenario', 'communication'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MASK = '********';
const POLL = 10000;
const MAX_LOG = 2000;

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
    return {
        enabled: false, mode: 'fichier', groupDelay: 30, subjectPrefix: '[SCADA]',
        smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
        rules: []
    };
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
            config = Object.assign(defaults(), saved, { smtp: Object.assign(defaults().smtp, saved.smtp || {}) });
        }
    } catch (err) {
        logger.error(`notifications: config.json invalide (${err.message})`);
    }
    clearInterval(timer);
    timer = setInterval(() => poll().catch(err => logger.error(`notifications: ${err.message}`)), POLL);
    setTimeout(() => poll().catch(() => { /* next time */ }), 5000);
}

// ---------------------------------------------------------------- settings
function cleanEmails(list, field) {
    const values = (Array.isArray(list) ? list : String(list || '').split(/[,;\s]+/)).map(e => String(e).trim()).filter(Boolean);
    const bad = values.filter(e => !EMAIL.test(e));
    if (bad.length) {
        throw httpError(400, 'invalid_request', `Adresse email invalide : ${bad.join(', ')}.`, { field });
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
        const recipients = cleanEmails(r.recipients, 'recipients');
        const toAccounts = !!r.accounts;
        if (!recipients.length && !toAccounts) {
            throw httpError(400, 'invalid_request', `${name} : aucun destinataire (adresses ou comptes des sites).`, { index: i, field: 'recipients' });
        }
        const minRole = ['consultation', 'operateur', 'ingenieur', 'administrateur'].includes(r.minRole) ? r.minRole : 'operateur';
        return {
            id: /^[A-Za-z0-9_-]{1,40}$/.test(r.id || '') ? r.id : `n${Date.now().toString(36)}${i}`,
            name, enabled: r.enabled !== false, sites, levels, sources, recipients, accounts: toAccounts, minRole, onEnd: !!r.onEnd
        };
    });
}

function getConfig() {
    const c = JSON.parse(JSON.stringify(config));
    c.smtp.hasPassword = !!config.smtp.pass;
    c.smtp.pass = config.smtp.pass ? MASK : '';
    return c;
}

function setConfig(input, by) {
    const next = JSON.parse(JSON.stringify(config));
    if (input.enabled !== undefined) { next.enabled = !!input.enabled; }
    if (input.mode !== undefined) {
        if (!['smtp', 'fichier'].includes(input.mode)) {
            throw httpError(400, 'invalid_request', 'Mode invalide : smtp (serveur de messagerie) ou fichier (test).', { field: 'mode' });
        }
        next.mode = input.mode;
    }
    if (input.groupDelay !== undefined) {
        const d = Number(input.groupDelay);
        if (!Number.isFinite(d) || d < 0 || d > 3600) {
            throw httpError(400, 'invalid_request', 'Délai de regroupement invalide (0 à 3600 s).', { field: 'groupDelay' });
        }
        next.groupDelay = d;
    }
    if (input.subjectPrefix !== undefined) { next.subjectPrefix = String(input.subjectPrefix).slice(0, 40); }
    if (input.smtp) {
        const s = input.smtp;
        ['host', 'user', 'from'].forEach(k => { if (s[k] !== undefined) { next.smtp[k] = String(s[k]).trim().slice(0, 200); } });
        if (s.port !== undefined) {
            const p = Number(s.port);
            if (!Number.isInteger(p) || p < 1 || p > 65535) {
                throw httpError(400, 'invalid_request', 'Port SMTP invalide.', { field: 'smtp.port' });
            }
            next.smtp.port = p;
        }
        if (s.secure !== undefined) { next.smtp.secure = !!s.secure; }
        // the password is shown masked: unchanged when the mask comes back
        if (s.pass !== undefined && s.pass !== MASK) { next.smtp.pass = String(s.pass); }
        if (next.smtp.from && !EMAIL.test(next.smtp.from.replace(/^.*<([^>]+)>\s*$/, '$1'))) {
            throw httpError(400, 'invalid_request', 'Adresse de l’expéditeur invalide.', { field: 'smtp.from' });
        }
    }
    if (input.rules !== undefined) { next.rules = cleanRules(input.rules); }
    if (next.enabled && next.mode === 'smtp' && !next.smtp.host) {
        throw httpError(400, 'invalid_request', 'Serveur SMTP manquant pour envoyer les emails.', { field: 'smtp.host' });
    }
    config = next;
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
    accounts.journal({ type: 'notifications', action: 'paramètres', user: by || null, result: 'ok', detail: `Notifications ${config.enabled ? 'activées' : 'désactivées'}, ${config.rules.length} règle(s)` });
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

/** emails of the rule for a site: written ones + accounts with an email that can open the site */
function recipientsOf(rule, site) {
    const list = rule.recipients.slice();
    if (rule.accounts) {
        accounts.listUsers().filter(u => u.active && u.email && EMAIL.test(u.email)).forEach(u => {
            const user = accounts.findUser(u.username);
            if (accounts.atLeast(accounts.roleOn(user, site), rule.minRole)) {
                list.push(u.email);
            }
        });
    }
    return Array.from(new Set(list));
}

// ---------------------------------------------------------------- emails
function esc(t) {
    return String(t === null || t === undefined ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function dateText(ms) {
    if (!ms) { return ''; }
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** one email per recipient with all the alarms of the queue for him */
async function flush() {
    const items = queue;
    queue = [];
    const byRecipient = {};
    items.forEach(item => {
        recipientsOf(item.rule, item.site).forEach(email => {
            const list = byRecipient[email] = byRecipient[email] || [];
            // the same alarm by two rules: once
            if (!list.some(x => x.site === item.site && x.kind === item.kind && keyOf(x.alarm) === keyOf(item.alarm))) {
                list.push(item);
            }
        });
    });
    for (const email of Object.keys(byRecipient)) {
        await sendMail(email, byRecipient[email]);
    }
}

function compose(items) {
    const starts = items.filter(i => i.kind === 'debut');
    const critical = starts.filter(i => i.alarm.type === 'highhigh').length;
    const sites = Array.from(new Set(items.map(i => i.site)));
    let subject;
    if (items.length === 1) {
        const i = items[0];
        subject = `${i.kind === 'fin' ? 'Fin d’alarme' : 'Alarme ' + (LEVEL_TEXT[i.alarm.type] || '').toLowerCase()} - ${i.site} - ${i.alarm.text}`;
    } else {
        subject = `${starts.length} nouvelle(s) alarme(s)${critical ? ` dont ${critical} critique(s)` : ''}${items.length > starts.length ? `, ${items.length - starts.length} fin(s)` : ''} - ${sites.join(', ')}`;
    }
    subject = `${config.subjectPrefix ? config.subjectPrefix + ' ' : ''}${subject}`.slice(0, 200);
    const color = { highhigh: '#c62828', high: '#ef6c00', low: '#f9a825', info: '#1565c0' };
    const rows = items.map(i => {
        const a = i.alarm;
        return `<tr><td style="padding:4px 8px;border:1px solid #ccc">${esc(i.site)}</td>` +
            `<td style="padding:4px 8px;border:1px solid #ccc"><span style="background:${color[a.type] || '#555'};color:#fff;padding:1px 8px;border-radius:9px">${esc(LEVEL_TEXT[a.type] || a.type)}</span></td>` +
            `<td style="padding:4px 8px;border:1px solid #ccc">${i.kind === 'fin' ? 'Fin' : 'Début'}</td>` +
            `<td style="padding:4px 8px;border:1px solid #ccc">${esc(dateText(i.kind === 'fin' ? (a.offtime || i.time) : a.ontime))}</td>` +
            `<td style="padding:4px 8px;border:1px solid #ccc">${esc(a.text)}</td><td style="padding:4px 8px;border:1px solid #ccc">${esc(a.device || '')}</td>` +
            `<td style="padding:4px 8px;border:1px solid #ccc">${esc(a.tag || '')}</td><td style="padding:4px 8px;border:1px solid #ccc">${esc(a.value === null || a.value === undefined ? '' : a.value)}</td>` +
            `<td style="padding:4px 8px;border:1px solid #ccc">${esc(a.sourceText || '')}</td></tr>`;
    }).join('');
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">` +
        `<h2 style="color:#1f3864">Alarmes des sites</h2>` +
        `<table style="border-collapse:collapse;font-size:13px"><tr style="background:#1f3864;color:#fff"><th style="padding:4px 8px">Site</th><th style="padding:4px 8px">Priorité</th>` +
        `<th style="padding:4px 8px">Événement</th><th style="padding:4px 8px">Heure</th><th style="padding:4px 8px">Message</th><th style="padding:4px 8px">Équipement</th>` +
        `<th style="padding:4px 8px">Tag</th><th style="padding:4px 8px">Valeur</th><th style="padding:4px 8px">Source</th></tr>${rows}</table>` +
        `<p style="color:#777;font-size:12px">Message envoyé automatiquement par custom-SCADA. Les alarmes s’acquittent dans la page Alarmes de chaque site.</p></div>`;
    const text = items.map(i => `${i.site} | ${LEVEL_TEXT[i.alarm.type] || i.alarm.type} | ${i.kind === 'fin' ? 'Fin' : 'Début'} | ` +
        `${dateText(i.kind === 'fin' ? (i.alarm.offtime || i.time) : i.alarm.ontime)} | ${i.alarm.text} | ${i.alarm.device || ''} | ${i.alarm.tag || ''}`).join('\n');
    return { subject, html, text };
}

function transport() {
    const nodemailer = require('nodemailer');
    if (config.mode === 'fichier') {
        return nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
    }
    const s = config.smtp;
    return nodemailer.createTransport({
        host: s.host, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass: s.pass } : undefined,
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
    });
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

async function sendMail(to, items, test) {
    const mail = test ? {
        subject: `${config.subjectPrefix ? config.subjectPrefix + ' ' : ''}Email de test des notifications`,
        text: 'Les notifications des alarmes de custom-SCADA fonctionnent.',
        html: '<p style="font-family:Arial,sans-serif">Les notifications des alarmes de <b>custom-SCADA</b> fonctionnent.</p>'
    } : compose(items);
    const entry = {
        time: Date.now(), to, subject: mail.subject, mode: config.mode, test: !!test,
        count: items.length, sites: Array.from(new Set(items.map(i => i.site))), status: 'envoyé', error: null, file: null
    };
    try {
        const from = config.smtp.from || 'custom-scada@localhost';
        const info = await transport().sendMail({ from, to, subject: mail.subject, text: mail.text, html: mail.html });
        if (config.mode === 'fichier') {
            const folder = path.join(dir, 'envoyes');
            if (!fs.existsSync(folder)) { fs.mkdirSync(folder); }
            entry.file = `${new Date().toISOString().replace(/[:.]/g, '-')}-${to.replace(/[^A-Za-z0-9@._-]/g, '_')}.eml`;
            fs.writeFileSync(path.join(folder, entry.file), info.message);
            entry.status = 'écrit (test)';
        }
    } catch (err) {
        entry.status = 'échec';
        entry.error = err.message;
        logger.error(`notifications: email to ${to} failed (${err.message})`);
    }
    log(entry);
    return entry;
}

async function test(to, by) {
    const list = cleanEmails(to, 'to');
    if (!list.length) {
        throw httpError(400, 'invalid_request', 'Adresse du destinataire manquante.', { field: 'to' });
    }
    const results = [];
    for (const email of list) {
        results.push(await sendMail(email, [], true));
    }
    accounts.journal({ type: 'notifications', action: 'email de test', user: by || null, result: 'ok', detail: `Email de test vers ${list.join(', ')}` });
    return results;
}

function history(limit) {
    const file = path.join(dir, 'envois.jsonl');
    if (!fs.existsSync(file)) { return []; }
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter(Boolean).reverse().slice(0, limit || 200);
}

function status() {
    return { enabled: config.enabled, mode: config.mode, rules: config.rules.filter(r => r.enabled).length, waiting: queue.length, lastPoll };
}

module.exports = { init, getConfig, setConfig, test, history, status, LEVELS, SOURCES, _poll: poll, _flush: flush };
