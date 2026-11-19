/**
 * custom-SCADA: central accounts of the sites (runs in the main FUXA)
 *
 * One account per user for all the sites, with the rights given site by site:
 *   role on each site: consultation < operateur < ingenieur < administrateur (or no access),
 *   optional list of the equipments (connections) the user may command on a site.
 * Sessions: cookie scada_session (JWT with a session id), absolute duration and inactivity timeout,
 * revocable; a recent password confirmation is needed for the critical operations.
 * Journal of the connections and of the operations: sites/_comptes/journal.jsonl.
 * While the security of the sites is disabled (no administrator yet), everything stays open as before.
 * Files in sites/_comptes/: comptes.json (users, settings), sessions.json, secret.key, journal.jsonl
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const ROLES = ['consultation', 'operateur', 'ingenieur', 'administrateur'];
const ROLE_TEXT = { consultation: 'consultation', operateur: 'opérateur', ingenieur: 'ingénieur', administrateur: 'administrateur' };
const COOKIE = 'scada_session';
const USER_HEADER = 'x-scada-user';
const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const MAX_FAILS = 5;
const LOCK_TIME = 10 * 60 * 1000;
const CONFIRM_TIME = 5 * 60 * 1000;
const JOURNAL_MAX = 20000;
const DEFAULT_SETTINGS = { enabled: false, idleMinutes: 30, sessionHours: 12, minPasswordLength: 8 };

var dir;
var logger;
var data = { users: [], settings: Object.assign({}, DEFAULT_SETTINGS) };
var sessions = {};          // sid: { sid, user, created, last, ip, agent, confirmedUntil }
var secret;
var saveSessionsTimer = null;

function init(sitesDir, _logger) {
    logger = _logger;
    dir = path.join(sitesDir, '_comptes');
    fs.mkdirSync(dir, { recursive: true });
    const secretFile = path.join(dir, 'secret.key');
    if (!fs.existsSync(secretFile)) {
        fs.writeFileSync(secretFile, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
    }
    secret = fs.readFileSync(secretFile, 'utf8').trim();
    try {
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'comptes.json'), 'utf8'));
        data = { users: Array.isArray(saved.users) ? saved.users : [], settings: Object.assign({}, DEFAULT_SETTINGS, saved.settings) };
    } catch (err) {
        // no account yet
    }
    try {
        sessions = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) || {};
    } catch (err) {
        sessions = {};
    }
    cleanSessions();
}

/** secret shared with the instances of the sites (signature of the user header) */
function siteSecret() {
    return secret;
}

function save() {
    fs.writeFileSync(path.join(dir, 'comptes.json'), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function saveSessions() {
    clearTimeout(saveSessionsTimer);
    saveSessionsTimer = setTimeout(() => {
        try {
            fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(sessions), { mode: 0o600 });
        } catch (err) {
            logger.error(`accounts: ${err.message}`);
        }
    }, 2000);
}

function httpError(status, code, message, details) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    err.details = details;
    return err;
}

// ---------------------------------------------------------------- journal

/**
 * event of the journal: { time, user, ip, site, type: connexion | operation | compte | securite | refus, action, detail, result }
 */
function journal(event) {
    const line = JSON.stringify(Object.assign({ time: Date.now() }, event));
    const file = path.join(dir, 'journal.jsonl');
    try {
        fs.appendFileSync(file, line + '\n');
        // the journal keeps the last events
        const stat = fs.statSync(file);
        if (stat.size > 8 * 1024 * 1024) {
            const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
            fs.writeFileSync(file, lines.slice(-JOURNAL_MAX).join('\n') + '\n');
        }
    } catch (err) {
        logger.error(`accounts journal: ${err.message}`);
    }
}

function readJournal(file) {
    try {
        return fs.readFileSync(file, 'utf8').trim().split('\n').filter(l => l).map(l => {
            try { return JSON.parse(l); } catch (err) { return null; }
        }).filter(e => e);
    } catch (err) {
        return [];
    }
}

/** journal of the accounts + journals of the setpoints written by the sites */
function readAllJournals(sitesDir, siteNames) {
    let events = readJournal(path.join(dir, 'journal.jsonl'));
    (siteNames || []).forEach(name => {
        events = events.concat(readJournal(path.join(sitesDir, name, '_appdata', 'journal-consignes.jsonl')).map(e => Object.assign({ site: name }, e)));
    });
    return events.sort((a, b) => b.time - a.time);
}

// ---------------------------------------------------------------- users

function publicUser(u) {
    return {
        username: u.username, name: u.name || '', email: u.email || '', active: u.active !== false,
        admin: !!u.admin, defaultRole: u.defaultRole || null, sites: u.sites || {}, equipments: u.equipments || {},
        created: u.created, lastLogin: u.lastLogin || null, locked: !!(u.lockedUntil && u.lockedUntil > Date.now())
    };
}

function findUser(username) {
    return data.users.find(u => u.username === String(username || '').toLowerCase());
}

function checkPassword(password) {
    const min = data.settings.minPasswordLength || 8;
    if (typeof password !== 'string' || password.length < min || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
        throw httpError(400, 'weak_password', `Mot de passe trop faible : ${min} caractères au moins, avec des lettres et des chiffres.`, { field: 'password' });
    }
}

/**
 * rights of an account: admin (all the sites, all the rights), defaultRole (sites not listed),
 * sites { site: role | 'aucun' }, equipments { site: [connection names] } (empty: all)
 */
function cleanRights(input, siteNames) {
    const sites = {};
    Object.keys(input.sites || {}).forEach(site => {
        const role = input.sites[site];
        if (!siteNames.includes(site)) {
            throw httpError(400, 'invalid_request', `Site inconnu : ${site}.`, { field: 'sites' });
        }
        if (role !== 'aucun' && !ROLES.includes(role)) {
            throw httpError(400, 'invalid_request', `Rôle invalide pour ${site} : ${ROLES.join(', ')} ou aucun.`, { field: 'sites' });
        }
        sites[site] = role;
    });
    const equipments = {};
    Object.keys(input.equipments || {}).forEach(site => {
        const list = Array.isArray(input.equipments[site]) ? input.equipments[site].map(x => String(x).trim()).filter(x => x) : [];
        if (list.length) {
            equipments[site] = list.slice(0, 100);
        }
    });
    if (input.defaultRole !== undefined && input.defaultRole !== null && input.defaultRole !== '' && input.defaultRole !== 'aucun' && !ROLES.includes(input.defaultRole)) {
        throw httpError(400, 'invalid_request', `Rôle par défaut invalide : ${ROLES.join(', ')} ou aucun.`, { field: 'defaultRole' });
    }
    return {
        admin: !!input.admin,
        defaultRole: input.defaultRole && input.defaultRole !== 'aucun' ? input.defaultRole : null,
        sites, equipments
    };
}

function createUser(input, siteNames, by) {
    const username = String(input.username || '').trim().toLowerCase();
    if (!LOGIN_RE.test(username)) {
        throw httpError(400, 'invalid_request', 'Identifiant invalide : 3 à 40 caractères, lettres minuscules, chiffres, point, tiret ou _.', { field: 'username' });
    }
    if (findUser(username)) {
        throw httpError(409, 'user_exists', `Le compte « ${username} » existe déjà.`);
    }
    checkPassword(input.password);
    const user = Object.assign({
        username, name: String(input.name || '').trim().slice(0, 80), email: String(input.email || '').trim().slice(0, 120),
        password: bcrypt.hashSync(input.password, 10), active: input.active !== false, created: Date.now(), fails: 0
    }, cleanRights(input, siteNames));
    data.users.push(user);
    save();
    journal({ type: 'compte', user: by || username, action: 'création du compte', detail: `${username}${user.admin ? ' (administrateur)' : ''}` });
    return publicUser(user);
}

function updateUser(username, input, siteNames, by) {
    const user = findUser(username);
    if (!user) {
        throw httpError(404, 'user_not_found', `Compte inconnu : ${username}`);
    }
    const before = JSON.stringify(publicUser(user));
    if (input.name !== undefined) { user.name = String(input.name).trim().slice(0, 80); }
    if (input.email !== undefined) { user.email = String(input.email).trim().slice(0, 120); }
    if (input.active !== undefined) { user.active = !!input.active; }
    if (input.sites !== undefined || input.admin !== undefined || input.defaultRole !== undefined || input.equipments !== undefined) {
        Object.assign(user, cleanRights({
            admin: input.admin !== undefined ? input.admin : user.admin,
            defaultRole: input.defaultRole !== undefined ? input.defaultRole : user.defaultRole,
            sites: input.sites !== undefined ? input.sites : user.sites,
            equipments: input.equipments !== undefined ? input.equipments : user.equipments
        }, siteNames));
    }
    if (input.password) {
        checkPassword(input.password);
        user.password = bcrypt.hashSync(input.password, 10);
        user.fails = 0;
        user.lockedUntil = 0;
        revokeUserSessions(user.username, 'mot de passe modifié');
    }
    if (input.unlock) {
        user.fails = 0;
        user.lockedUntil = 0;
    }
    checkAdminLeft();
    if (user.active === false) {
        revokeUserSessions(user.username, 'compte désactivé');
    }
    save();
    const after = JSON.stringify(publicUser(user));
    journal({ type: 'compte', user: by, action: 'modification du compte', detail: `${user.username}${input.password ? ' : mot de passe' : ''}${before !== after ? ' : droits / informations' : ''}` });
    return publicUser(user);
}

function deleteUser(username, by) {
    const user = findUser(username);
    if (!user) {
        throw httpError(404, 'user_not_found', `Compte inconnu : ${username}`);
    }
    data.users = data.users.filter(u => u !== user);
    try {
        checkAdminLeft();
    } catch (err) {
        data.users.push(user);
        throw err;
    }
    revokeUserSessions(user.username, 'compte supprimé');
    save();
    journal({ type: 'compte', user: by, action: 'suppression du compte', detail: user.username });
}

/** with the security enabled, an active administrator must stay */
function checkAdminLeft() {
    if (data.settings.enabled && !data.users.some(u => u.admin && u.active !== false)) {
        throw httpError(409, 'last_admin', 'Il faut garder au moins un administrateur actif tant que la sécurité est activée.');
    }
}

function setSettings(input, by) {
    const next = Object.assign({}, data.settings);
    if (input.enabled !== undefined) { next.enabled = !!input.enabled; }
    const num = (v, min, max, name) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < min || n > max) {
            throw httpError(400, 'invalid_request', `${name} invalide : entier entre ${min} et ${max}.`, { field: name });
        }
        return n;
    };
    if (input.idleMinutes !== undefined) { next.idleMinutes = num(input.idleMinutes, 5, 1440, 'idleMinutes'); }
    if (input.sessionHours !== undefined) { next.sessionHours = num(input.sessionHours, 1, 168, 'sessionHours'); }
    if (input.minPasswordLength !== undefined) { next.minPasswordLength = num(input.minPasswordLength, 8, 64, 'minPasswordLength'); }
    if (next.enabled && !data.users.some(u => u.admin && u.active !== false)) {
        throw httpError(409, 'no_admin', 'Créer d’abord un compte administrateur actif.');
    }
    const changed = next.enabled !== data.settings.enabled;
    data.settings = next;
    save();
    journal({ type: 'securite', user: by, action: changed ? (next.enabled ? 'sécurité activée' : 'sécurité désactivée') : 'paramètres de sécurité modifiés',
        detail: `inactivité ${next.idleMinutes} min, session ${next.sessionHours} h` });
    return Object.assign({}, data.settings);
}

// ---------------------------------------------------------------- rights

/** role of a user on a site (null: no access) */
function roleOn(user, site) {
    if (!user) {
        return null;
    }
    if (user.admin) {
        return 'administrateur';
    }
    const role = user.sites && user.sites[site];
    if (role === 'aucun') {
        return null;
    }
    return role || user.defaultRole || null;
}

function atLeast(role, needed) {
    return !!role && ROLES.indexOf(role) >= ROLES.indexOf(needed);
}

/** sites the user can open */
function visibleSites(user, siteNames) {
    return siteNames.filter(s => roleOn(user, s));
}

// ---------------------------------------------------------------- sessions

function cleanSessions() {
    const now = Date.now();
    let changed = false;
    Object.keys(sessions).forEach(sid => {
        if (expired(sessions[sid], now)) {
            delete sessions[sid];
            changed = true;
        }
    });
    if (changed) {
        saveSessions();
    }
}

function expired(s, now) {
    const st = data.settings;
    return now - s.last > st.idleMinutes * 60000 || now - s.created > st.sessionHours * 3600000;
}

/** login: password checked, account locked 10 min after 5 failures */
function login(username, password, ip, agent) {
    const user = findUser(username);
    const fail = (reason) => {
        journal({ type: 'connexion', user: String(username || '').toLowerCase(), ip, action: 'échec de connexion', detail: reason, result: 'refus' });
        return httpError(401, 'login_failed', 'Identifiant ou mot de passe incorrect.');
    };
    if (!user) {
        throw fail('compte inconnu');
    }
    if (user.lockedUntil && user.lockedUntil > Date.now()) {
        journal({ type: 'connexion', user: user.username, ip, action: 'échec de connexion', detail: 'compte verrouillé', result: 'refus' });
        throw httpError(423, 'account_locked', `Compte verrouillé après ${MAX_FAILS} échecs : réessayer dans ${Math.ceil((user.lockedUntil - Date.now()) / 60000)} min ou demander à un administrateur.`);
    }
    if (user.active === false) {
        throw fail('compte désactivé');
    }
    if (!bcrypt.compareSync(String(password || ''), user.password)) {
        user.fails = (user.fails || 0) + 1;
        if (user.fails >= MAX_FAILS) {
            user.lockedUntil = Date.now() + LOCK_TIME;
            user.fails = 0;
            journal({ type: 'securite', user: user.username, ip, action: 'compte verrouillé', detail: `${MAX_FAILS} échecs de connexion` });
        }
        save();
        throw fail('mot de passe incorrect');
    }
    user.fails = 0;
    user.lastLogin = Date.now();
    save();
    const sid = crypto.randomBytes(18).toString('base64url');
    const now = Date.now();
    sessions[sid] = { sid, user: user.username, created: now, last: now, ip, agent: String(agent || '').slice(0, 160), confirmedUntil: 0 };
    saveSessions();
    journal({ type: 'connexion', user: user.username, ip, action: 'connexion', result: 'ok' });
    const token = jwt.sign({ sid, sub: user.username }, secret, { expiresIn: `${data.settings.sessionHours}h` });
    return { token, user: me(user, sessions[sid]) };
}

/** session of a request (cookie or Authorization: Bearer), null if none or expired */
function sessionOf(req) {
    const token = tokenOf(req);
    if (!token) {
        return null;
    }
    let payload;
    try {
        payload = jwt.verify(token, secret);
    } catch (err) {
        return null;
    }
    const s = sessions[payload.sid];
    const now = Date.now();
    if (!s || s.user !== payload.sub) {
        return null;
    }
    if (expired(s, now)) {
        delete sessions[s.sid];
        saveSessions();
        journal({ type: 'connexion', user: s.user, ip: s.ip, action: 'session expirée', detail: 'inactivité ou durée maximale' });
        return { expired: true };
    }
    const user = findUser(s.user);
    if (!user || user.active === false) {
        delete sessions[s.sid];
        saveSessions();
        return null;
    }
    if (now - s.last > 15000) {
        s.last = now;
        saveSessions();
    }
    return { session: s, user };
}

function tokenOf(req) {
    const auth = req.headers.authorization || '';
    if (/^Bearer /i.test(auth)) {
        return auth.slice(7).trim();
    }
    const cookies = String(req.headers.cookie || '').split(';').map(c => c.trim());
    const found = cookies.find(c => c.startsWith(COOKIE + '='));
    return found ? decodeURIComponent(found.slice(COOKIE.length + 1)) : null;
}

function logout(session, reason) {
    if (session && sessions[session.sid]) {
        delete sessions[session.sid];
        saveSessions();
        journal({ type: 'connexion', user: session.user, ip: session.ip, action: reason || 'déconnexion' });
    }
}

function revokeUserSessions(username, reason) {
    Object.values(sessions).filter(s => s.user === username).forEach(s => logout(s, `session fermée (${reason})`));
}

function revokeSession(sid, by) {
    const s = sessions[sid];
    if (!s) {
        throw httpError(404, 'session_not_found', 'Session inconnue.');
    }
    logout(s, `session fermée par ${by}`);
}

function listSessions() {
    cleanSessions();
    const st = data.settings;
    return Object.values(sessions).map(s => ({
        sid: s.sid, user: s.user, ip: s.ip, agent: s.agent, created: s.created, last: s.last,
        expires: Math.min(s.last + st.idleMinutes * 60000, s.created + st.sessionHours * 3600000)
    })).sort((a, b) => b.last - a.last);
}

/** password typed again: the critical operations are allowed for 5 minutes */
function confirm(sess, password) {
    if (!bcrypt.compareSync(String(password || ''), sess.user.password)) {
        journal({ type: 'securite', user: sess.user.username, ip: sess.session.ip, action: 'confirmation refusée', result: 'refus' });
        throw httpError(401, 'confirmation_failed', 'Mot de passe incorrect.');
    }
    sess.session.confirmedUntil = Date.now() + CONFIRM_TIME;
    saveSessions();
    journal({ type: 'securite', user: sess.user.username, ip: sess.session.ip, action: 'confirmation du mot de passe' });
    return { confirmedUntil: sess.session.confirmedUntil };
}

function isConfirmed(sess) {
    return !!(sess && sess.session && sess.session.confirmedUntil > Date.now());
}

function me(user, session) {
    return Object.assign(publicUser(user), {
        roleText: user.admin ? 'administrateur' : null,
        session: session ? { created: session.created, confirmedUntil: session.confirmedUntil || 0 } : null
    });
}

// ---------------------------------------------------------------- user header for the sites

/** user signed for the instance of a site: { username, name, role, equipments } */
function userHeader(user, site, session) {
    const payload = Buffer.from(JSON.stringify({
        username: user.username, name: user.name || '', role: roleOn(user, site),
        equipments: (user.equipments && user.equipments[site]) || [], time: Date.now(),
        // password typed again recently (critical commands)
        confirmed: !!(session && session.confirmedUntil > Date.now())
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

module.exports = {
    init,
    siteSecret,
    journal,
    readAllJournals,
    createUser,
    updateUser,
    deleteUser,
    listUsers: () => data.users.map(publicUser),
    findUser,
    getSettings: () => Object.assign({}, data.settings),
    setSettings,
    enabled: () => !!data.settings.enabled,
    hasAdmin: () => data.users.some(u => u.admin && u.active !== false),
    login,
    logout,
    sessionOf,
    listSessions,
    revokeSession,
    confirm,
    isConfirmed,
    me,
    roleOn,
    atLeast,
    visibleSites,
    userHeader,
    ROLES,
    ROLE_TEXT,
    COOKIE,
    USER_HEADER
};
