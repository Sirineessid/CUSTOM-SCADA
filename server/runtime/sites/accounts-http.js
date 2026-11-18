/**
 * custom-SCADA: HTTP part of the central accounts (runs in the main FUXA)
 *
 * - gate(): every request goes through it before FUXA and the sites. While the security is disabled it does nothing.
 *   Enabled: a valid session is needed (else 401 for the API, login page for the pages), then the role of the user
 *   on the site is checked for the asked operation (403 if not enough, 403 confirmation_required for the critical ones),
 *   and every operation (not GET) is written in the journal with its result.
 * - pages /connexion and /comptes, API /api/v1/auth (login, logout, me, confirm) and /api/v1/accounts (administrators)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const accounts = require('./accounts');
const { ApiError, send, sendError, handle, jsonErrors, body } = require('./api-v1-common');

const SITE_URL = /^\/site\/([^/?#]+)(\/[^?#]*)?/;
const V1_SITE = /^\/api\/v1\/sites\/([^/?#]+)(?:\/([^?#]*))?/;
const PUBLIC = [/^\/connexion(\?.*)?$/, /^\/comptes(\.js)?(\?.*)?$/, /^\/api\/v1\/auth\//, /^\/favicon\.ico$/];

/**
 * @param manager { names(): site names, request(site name, method, path) }
 */
function create(manager, settings, logger) {
    const h = fnc => handle(fnc, logger);

    const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    // ---------------------------------------------------------------- rules
    /**
     * operation asked: { site, role (on the site) } or { hub: true, role ('logged' | 'admin') }, confirm: password confirmed recently
     */
    function rule(req) {
        const url = (req.originalUrl || req.url).split('?')[0];
        const method = req.method;
        const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
        let m = url.match(V1_SITE);
        if (m) {
            const site = decodeURIComponent(m[1]);
            const service = (m[2] || '').replace(/\/+$/, '');
            if (!service) {
                return method === 'GET' ? { site, role: 'consultation' } : { hub: true, role: 'admin', confirm: method === 'DELETE' };
            }
            return siteRule(site, method, service, write, true);
        }
        m = url.match(SITE_URL);
        if (m) {
            const site = decodeURIComponent(m[1]);
            const rest = m[2] || '/';
            if (/^\/api\/v1(\/|$)/.test(rest)) {
                return siteRule(site, method, rest.replace(/^\/api\/v1\/?/, '').replace(/\/+$/, ''), write, false);
            }
            if (/^\/(editor|lab)(\/|$)/.test(rest)) {
                return { site, role: 'ingenieur' };
            }
            if (/^\/api\/sites/.test(rest)) {
                return write ? { hub: true, role: 'admin' } : { hub: true, role: 'logged' };
            }
            if (!write) {
                return { site, role: 'consultation' };
            }
            // FUXA of the site: acknowledgement of the alarms by the operators, the other changes by the engineers
            return { site, role: /^\/api\/(alarmack|alarms\/ack)/i.test(rest) ? 'operateur' : 'ingenieur' };
        }
        if (/^\/api\/v1\/notifications(\/|$)/.test(url)) {
            return { hub: true, role: 'admin' };
        }
        if (/^\/api\/v1\/accounts(\/|$)/.test(url)) {
            return { hub: true, role: 'admin', confirm: write && (method === 'DELETE' || /\/settings$/.test(url)) };
        }
        if (/^\/api\/v1\/sites\/?$/.test(url)) {
            return write ? { hub: true, role: 'admin' } : { hub: true, role: 'logged' };
        }
        if (/^\/api\/sites/.test(url)) {
            return write || /\/export/.test(url) ? { hub: true, role: 'admin', confirm: method === 'DELETE' } : { hub: true, role: 'logged' };
        }
        if (/^\/api\/(v1|export)(\/|$)/.test(url)) {
            return { hub: true, role: 'logged' };
        }
        // main FUXA (editor of the main project, its API)
        if (/^\/(editor|lab)(\/|$)/.test(url)) {
            return { hub: true, role: 'engineer-somewhere' };
        }
        return write ? { hub: true, role: 'admin' } : { hub: true, role: 'logged' };
    }

    function siteRule(site, method, service, write, v1) {
        if (!write) {
            if (/^(export|backups\/[^/]+)$/.test(service)) {
                return { site, role: 'ingenieur' };
            }
            return { site, role: 'consultation' };
        }
        if (/^alarms\/(ack|[^/]+\/ack)$/.test(service) || /^commands(\/|$)/.test(service)) {
            return { site, role: 'operateur' };
        }
        if (/^versions\/[^/]+\/restore$/.test(service)) {
            return { site, role: 'ingenieur', confirm: true };
        }
        if (/^backups\/[^/]+\/restore$/.test(service) || (method === 'DELETE' && /^backups\//.test(service))) {
            return { site, role: 'administrateur', confirm: true };
        }
        if (v1 && /^(start|stop|rename)$/.test(service)) {
            return { hub: true, role: 'admin' };
        }
        return { site, role: 'ingenieur' };
    }

    function allowed(user, r) {
        if (r.hub) {
            if (r.role === 'logged') { return true; }
            if (r.role === 'admin') { return !!user.admin; }
            if (r.role === 'engineer-somewhere') {
                return !!user.admin || manager.names().some(s => accounts.atLeast(accounts.roleOn(user, s), 'ingenieur'));
            }
            return false;
        }
        return accounts.atLeast(accounts.roleOn(user, r.site), r.role);
    }

    // ---------------------------------------------------------------- gate
    function wantsJson(req) {
        const url = req.originalUrl || req.url;
        return /\/api\//.test(url) || /json/.test(req.headers.accept || '') || req.method !== 'GET';
    }

    function deny(req, res, status, code, message, sess) {
        if (status === 403 && sess) {
            accounts.journal({ type: 'refus', user: sess.user.username, ip: ipOf(req), action: `${req.method} ${(req.originalUrl || req.url).split('?')[0]}`, detail: message, result: 'refus' });
        }
        if (wantsJson(req)) {
            return sendError(res, new ApiError(status, code, message));
        }
        if (status === 401) {
            return res.redirect(`/connexion?next=${encodeURIComponent(req.originalUrl || req.url)}${code === 'session_expired' ? '&expire=1' : ''}`);
        }
        res.status(status).type('html').send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Accès refusé</title></head>
<body style="font-family:Arial;padding:40px"><h2>Accès refusé</h2><p>${message.replace(/</g, '&lt;')}</p><p><a href="/connexion">Changer de compte</a></p></body></html>`);
    }

    /** operations (not GET) written in the journal with their result */
    function trace(req, res, sess, r) {
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            return;
        }
        const url = (req.originalUrl || req.url).split('?')[0];
        res.on('finish', () => {
            accounts.journal({
                type: 'operation', user: sess ? sess.user.username : null, ip: ipOf(req), site: r && r.site ? r.site : null,
                action: `${req.method} ${url}`, result: res.statusCode < 400 ? 'ok' : `erreur ${res.statusCode}`
            });
        });
    }

    function gate(req, res, next) {
        const url = req.originalUrl || req.url;
        if (!accounts.enabled()) {
            return next();
        }
        if (PUBLIC.some(re => re.test(url))) {
            return next();
        }
        const sess = accounts.sessionOf(req);
        if (!sess || sess.expired) {
            return deny(req, res, 401, sess && sess.expired ? 'session_expired' : 'login_required',
                sess && sess.expired ? 'Session expirée : se reconnecter.' : 'Connexion nécessaire.');
        }
        const r = rule(req);
        if (!allowed(sess.user, r)) {
            const role = r.hub ? (r.role === 'admin' ? 'administrateur' : 'ingénieur') : accounts.ROLE_TEXT[r.role];
            return deny(req, res, 403, 'forbidden', r.site
                ? `Droits insuffisants sur le site ${r.site} : rôle ${role} nécessaire.`
                : `Droits insuffisants : rôle ${role} nécessaire.`, sess);
        }
        if (r.confirm && !accounts.isConfirmed(sess)) {
            return deny(req, res, 403, 'confirmation_required', 'Opération sensible : confirmer le mot de passe (POST /api/v1/auth/confirm).', sess);
        }
        req.scadaUser = sess.user;
        req.scadaSession = sess.session;
        trace(req, res, sess, r);
        next();
    }

    /** websocket of a site: session and access to the site checked before the forwarding */
    function checkUpgrade(req, site) {
        if (!accounts.enabled()) {
            return { ok: true };
        }
        const sess = accounts.sessionOf(req);
        if (!sess || sess.expired || !accounts.roleOn(sess.user, site)) {
            return { ok: false };
        }
        return { ok: true, header: accounts.userHeader(sess.user, site) };
    }

    // ---------------------------------------------------------------- API
    const router = express.Router();
    const json = express.json({ limit: '200kb' });
    const withBody = [(req, res, next) => (req._body ? next() : json(req, res, next)), jsonErrors];
    const cookieOptions = req => ({ httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });

    router.get('/auth/status', h((req, res) => {
        const sess = accounts.sessionOf(req);
        send(res, { enabled: accounts.enabled(), setup: !accounts.hasAdmin(), user: sess && sess.user ? accounts.me(sess.user, sess.session) : null });
    }));

    router.post('/auth/login', withBody, h((req, res) => {
        const input = body(req);
        const result = accounts.login(input.username, input.password, ipOf(req), req.headers['user-agent']);
        res.cookie(accounts.COOKIE, result.token, cookieOptions(req));
        send(res, { user: result.user, token: result.token });
    }));

    router.post('/auth/logout', h((req, res) => {
        const sess = accounts.sessionOf(req);
        if (sess && sess.session) {
            accounts.logout(sess.session);
        }
        res.clearCookie(accounts.COOKIE, { path: '/' });
        send(res, { logout: true });
    }));

    router.get('/auth/me', h((req, res) => {
        const sess = accounts.sessionOf(req);
        if (!sess || !sess.user) {
            throw new ApiError(401, 'login_required', 'Connexion nécessaire.');
        }
        const names = manager.names();
        send(res, Object.assign(accounts.me(sess.user, sess.session), {
            siteRoles: accounts.visibleSites(sess.user, names).map(s => ({ site: s, role: accounts.roleOn(sess.user, s) }))
        }));
    }));

    /** password typed again before a critical operation */
    router.post('/auth/confirm', withBody, h((req, res) => {
        const sess = accounts.sessionOf(req);
        if (!sess || !sess.user) {
            throw new ApiError(401, 'login_required', 'Connexion nécessaire.');
        }
        send(res, accounts.confirm(sess, body(req).password));
    }));

    // administration (the gate checks the administrator role; first account: allowed without security)
    const by = req => (req.scadaUser ? req.scadaUser.username : 'installation');
    const adminOnly = (req, res, next) => {
        if (accounts.enabled()) {
            return next();
        }
        // security disabled: only the creation of the first administrator, then an administrator must log in
        const sess = accounts.sessionOf(req);
        if (sess && sess.user && sess.user.admin) {
            req.scadaUser = sess.user;
            return next();
        }
        if (!accounts.hasAdmin()) {
            return next();
        }
        sendError(res, new ApiError(401, 'login_required', 'Connexion d’un administrateur nécessaire.'));
    };

    router.get('/accounts/users', adminOnly, h((req, res) => {
        const users = accounts.listUsers();
        send(res, users, { count: users.length });
    }));

    router.post('/accounts/users', withBody, adminOnly, h((req, res) => {
        const input = body(req);
        if (!accounts.hasAdmin()) {
            // first account: administrator
            input.admin = true;
        }
        send(res, accounts.createUser(input, manager.names(), by(req)), null, 201);
    }));

    router.put('/accounts/users/:username', withBody, adminOnly, h((req, res) => {
        send(res, accounts.updateUser(req.params.username, body(req), manager.names(), by(req)));
    }));

    router.delete('/accounts/users/:username', adminOnly, h((req, res) => {
        if (req.scadaUser && req.scadaUser.username === req.params.username) {
            throw new ApiError(409, 'own_account', 'Impossible de supprimer son propre compte.');
        }
        accounts.deleteUser(req.params.username, by(req));
        send(res, { username: req.params.username, deleted: true });
    }));

    router.get('/accounts/sessions', adminOnly, h((req, res) => {
        send(res, accounts.listSessions());
    }));

    router.delete('/accounts/sessions/:sid', adminOnly, h((req, res) => {
        accounts.revokeSession(req.params.sid, by(req));
        send(res, { sid: req.params.sid, revoked: true });
    }));

    router.get('/accounts/settings', adminOnly, h((req, res) => {
        send(res, accounts.getSettings());
    }));

    router.put('/accounts/settings', withBody, adminOnly, h((req, res) => {
        send(res, accounts.setSettings(body(req), by(req)));
    }));

    /** journal: connections, operations, refusals, accounts, setpoints of the sites; filters user, site, type, from, to */
    router.get('/accounts/journal', adminOnly, h((req, res) => {
        const q = req.query;
        const from = Number(q.from) || Date.now() - 7 * 86400000, to = Number(q.to) || Date.now();
        let events = accounts.readAllJournals(manager.dir(), manager.names()).filter(e => e.time >= from && e.time <= to);
        if (q.user) { events = events.filter(e => e.user === q.user); }
        if (q.site) { events = events.filter(e => e.site === q.site); }
        if (q.type) { events = events.filter(e => e.type === q.type); }
        send(res, events.slice(0, 2000), { count: events.length, from, to });
    }));

    /** sites and their connections (choice of the rights of an account) */
    router.get('/accounts/sites', adminOnly, h(async (req, res) => {
        const result = [];
        for (const name of manager.names()) {
            let devices = [];
            try {
                devices = ((await manager.request(name, 'GET', '/api/v1/devices')) || {}).data || [];
            } catch (err) {
                // stopped site
            }
            result.push({ site: name, devices: devices.map(d => d.name) });
        }
        send(res, result, { roles: accounts.ROLES });
    }));

    // ---------------------------------------------------------------- pages
    const page = (file) => (req, res) => {
        res.set('Cache-Control', 'no-cache');
        res.type(file.endsWith('.js') ? 'application/javascript' : 'html').send(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    };
    const pages = express.Router();
    pages.get('/connexion', page('connexion.html'));
    pages.get('/comptes', page('comptes.html'));
    pages.get('/comptes.js', page('comptes.client.js'));
    pages.get('/alarmes', page('alarmes-sites.html'));
    pages.get('/alarmes-sites.js', page('alarmes-sites.client.js'));

    return { gate, checkUpgrade, router, pages };
}

module.exports = { create };
