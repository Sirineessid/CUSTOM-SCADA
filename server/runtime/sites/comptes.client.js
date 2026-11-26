/**
 * custom-SCADA: page /comptes of the main FUXA: central accounts of the sites (users, rights per site and per equipment),
 * open sessions, journal of the connections and operations, security settings. API /api/v1/accounts and /api/v1/auth.
 */
(function () {
    'use strict';

    var app = document.getElementById('app');
    var ROLES = [['consultation', 'Consultation'], ['operateur', 'Opérateur'], ['ingenieur', 'Ingénieur'], ['administrateur', 'Administrateur']];
    var ROLE_NAME = { consultation: 'consultation', operateur: 'opérateur', ingenieur: 'ingénieur', administrateur: 'administrateur', aucun: 'aucun accès' };
    var TYPES = { connexion: ['Connexion', 'st-info'], operation: ['Opération', 'st-ok'], compte: ['Compte', 'st-warning'], securite: ['Sécurité', 'st-warning'],
        refus: ['Refus', 'st-error'], consigne: ['Consigne', 'st-ok'] };
    var sites = [], users = [], me = null;

    function esc(t) {
        return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
        });
    }

    function date(ms) {
        if (!ms) { return '—'; }
        var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function status(id, text, error) {
        var el = document.getElementById(id);
        if (el) { el.textContent = text; el.className = 'status' + (error ? ' error' : ''); }
    }

    /** API: 401 -> login page; 403 confirmation_required -> password typed again, then the request again */
    function api(method, path, body) {
        var options = { method: method, credentials: 'same-origin', headers: {} };
        if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
        return fetch('/api/v1' + path, options).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (b) {
                if (r.status === 401 && b.error && /login_required|session_expired/.test(b.error.code)) {
                    location.href = '/connexion?next=' + encodeURIComponent('/comptes') + (b.error.code === 'session_expired' ? '&expire=1' : '');
                    throw new Error(b.error.message);
                }
                if (r.status === 403 && b.error && b.error.code === 'confirmation_required') {
                    var password = prompt('Opération sensible : confirmer votre mot de passe');
                    if (!password) { throw new Error('Opération annulée.'); }
                    return api('POST', '/auth/confirm', { password: password }).then(function () { return api(method, path, body); });
                }
                if (!r.ok) { throw new Error(b.error ? b.error.message : 'Erreur ' + r.status); }
                return b;
            });
        });
    }

    document.getElementById('logout').addEventListener('click', function (e) {
        e.preventDefault();
        api('POST', '/auth/logout').then(function () { location.href = '/connexion'; });
    });

    // ---------------------------------------------------------------- first administrator
    function setup() {
        document.getElementById('logout').style.display = 'none';
        app.innerHTML = '<div class="card"><h3>Créer le premier compte administrateur</h3>' +
            '<p class="info">Aucun compte n’existe encore. Ce compte administre tous les sites et les autres comptes. Ensuite, activer la sécurité dans l’onglet Sécurité.</p>' +
            '<div class="row"><label>Identifiant <input id="s-user" size="16" placeholder="ex. admin"></label><label>Nom <input id="s-name" size="20"></label>' +
            '<label>Mot de passe <input id="s-pass" type="password" size="16"></label><label>Confirmation <input id="s-pass2" type="password" size="16"></label>' +
            '<button id="s-create" class="primary">Créer</button><span id="s-status" class="status"></span></div></div>';
        document.getElementById('s-create').addEventListener('click', function () {
            var u = document.getElementById('s-user').value.trim(), p = document.getElementById('s-pass').value;
            if (p !== document.getElementById('s-pass2').value) { status('s-status', 'Les mots de passe sont différents.', true); return; }
            api('POST', '/accounts/users', { username: u, name: document.getElementById('s-name').value, password: p, admin: true })
                .then(function () { return api('POST', '/auth/login', { username: u, password: p }); })
                .then(function () { location.reload(); })
                .catch(function (err) { status('s-status', err.message, true); });
        });
    }

    // ---------------------------------------------------------------- page
    function main() {
        app.innerHTML = '<div class="tabs"><button data-tab="users" class="on">Utilisateurs</button><button data-tab="sessions">Sessions</button>' +
            '<button data-tab="journal">Journal</button><button data-tab="security">Sécurité</button></div>' +
            '<div id="tab-users"></div><div id="tab-sessions" style="display:none"></div><div id="tab-journal" style="display:none"></div><div id="tab-security" style="display:none"></div>';
        app.querySelectorAll('.tabs button').forEach(function (b) {
            b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
        });
        showTab('users');
    }

    function showTab(name) {
        app.querySelectorAll('.tabs button').forEach(function (b) { b.className = b.getAttribute('data-tab') === name ? 'on' : ''; });
        ['users', 'sessions', 'journal', 'security'].forEach(function (t) { document.getElementById('tab-' + t).style.display = t === name ? '' : 'none'; });
        ({ users: loadUsers, sessions: loadSessions, journal: loadJournal, security: loadSecurity })[name]();
    }

    // ---------------------------------------------------------------- users
    function rightsText(u) {
        if (u.admin) { return '<span class="st st-warning">administrateur de tous les sites</span>'; }
        var parts = sites.map(function (s) {
            var role = u.sites[s.site] || u.defaultRole;
            if (!role || role === 'aucun') { return null; }
            var eq = u.equipments[s.site];
            return esc(s.site) + ' : ' + esc(ROLE_NAME[role]) + (eq && eq.length ? ' (' + esc(eq.join(', ')) + ')' : '');
        }).filter(function (x) { return x; });
        return parts.join('<br>') || '<span class="st st-off">aucun site</span>';
    }

    function loadUsers() {
        var box = document.getElementById('tab-users');
        Promise.all([api('GET', '/accounts/users'), api('GET', '/accounts/sites')]).then(function (r) {
            users = r[0].data;
            sites = r[1].data;
            box.innerHTML = '<div class="row"><button id="u-new" class="primary">+ Nouveau compte</button><span id="u-status" class="status">' + users.length + ' compte(s)</span></div>' +
                '<div id="u-form"></div><table><thead><tr><th>Identifiant</th><th>Nom</th><th>Droits par site</th><th>État</th><th>Dernière connexion</th><th></th></tr></thead><tbody>' +
                users.map(function (u, i) {
                    return '<tr><td>' + esc(u.username) + '</td><td>' + esc(u.name) + (u.email ? '<br><small>' + esc(u.email) + '</small>' : '') + '</td><td>' + rightsText(u) + '</td>' +
                        '<td>' + (u.locked ? '<span class="st st-error">verrouillé</span>' : u.active ? '<span class="st st-ok">actif</span>' : '<span class="st st-off">désactivé</span>') + '</td>' +
                        '<td>' + date(u.lastLogin) + '</td><td style="white-space:nowrap"><button data-edit="' + i + '">Modifier</button> ' +
                        (me && me.username === u.username ? '' : '<button data-del="' + i + '">Supprimer</button>') + '</td></tr>';
                }).join('') + '</tbody></table>';
            document.getElementById('u-new').addEventListener('click', function () { editUser(null); });
            box.querySelector('tbody').addEventListener('click', function (e) {
                var i = e.target.getAttribute('data-edit'), d = e.target.getAttribute('data-del');
                if (i !== null) { editUser(users[Number(i)]); }
                if (d !== null) {
                    var u = users[Number(d)];
                    if (!confirm('Supprimer le compte « ' + u.username + ' » ?')) { return; }
                    api('DELETE', '/accounts/users/' + encodeURIComponent(u.username)).then(loadUsers).catch(function (err) { status('u-status', err.message, true); });
                }
            });
        }).catch(function (err) { box.innerHTML = '<p class="error">' + esc(err.message) + '</p>'; });
    }

    function roleOptions(selected, first) {
        return first + ROLES.map(function (r) { return '<option value="' + r[0] + '"' + (r[0] === selected ? ' selected' : '') + '>' + r[1] + '</option>'; }).join('');
    }

    function editUser(u) {
        var isNew = !u;
        u = u || { username: '', name: '', email: '', active: true, admin: false, defaultRole: null, sites: {}, equipments: {} };
        var form = document.getElementById('u-form');
        form.innerHTML = '<div class="card"><h3>' + (isNew ? 'Nouveau compte' : 'Modifier le compte « ' + esc(u.username) + ' »') + '</h3>' +
            '<div class="row"><label>Identifiant <input id="f-user" size="14" value="' + esc(u.username) + '"' + (isNew ? '' : ' disabled') + '></label>' +
            '<label>Nom <input id="f-name" size="20" value="' + esc(u.name) + '"></label><label>E-mail <input id="f-email" size="22" value="' + esc(u.email) + '"></label>' +
            '<label>' + (isNew ? 'Mot de passe' : 'Nouveau mot de passe') + ' <input id="f-pass" type="password" size="14" placeholder="' + (isNew ? '' : 'inchangé') + '"></label>' +
            '<label><input type="checkbox" id="f-active"' + (u.active ? ' checked' : '') + '> Actif</label>' +
            (u.locked ? '<label><input type="checkbox" id="f-unlock"> Déverrouiller</label>' : '') + '</div>' +
            '<div class="row"><label><input type="checkbox" id="f-admin"' + (u.admin ? ' checked' : '') + '> Administrateur (tous les sites, comptes, sécurité)</label>' +
            '<label>Rôle par défaut sur les autres sites <select id="f-default">' + roleOptions(u.defaultRole, '<option value="aucun">aucun accès</option>') + '</select></label></div>' +
            '<table id="f-sites"><thead><tr><th>Site</th><th>Rôle</th><th>Équipements commandables (aucun coché : tous)</th></tr></thead><tbody>' +
            sites.map(function (s, k) {
                var role = u.sites[s.site] || '';
                var eq = u.equipments[s.site] || [];
                return '<tr><td>' + esc(s.site) + '</td><td><select data-site="' + k + '">' + roleOptions(role, '<option value="">rôle par défaut</option><option value="aucun"' + (role === 'aucun' ? ' selected' : '') + '>aucun accès</option>') + '</select></td>' +
                    '<td>' + (s.devices.length ? s.devices.map(function (d) {
                        return '<label style="margin-right:10px"><input type="checkbox" data-eq="' + k + '" value="' + esc(d) + '"' + (eq.indexOf(d) >= 0 ? ' checked' : '') + '> ' + esc(d) + '</label>';
                    }).join('') : '<span class="info">site arrêté</span>') + '</td></tr>';
            }).join('') + '</tbody></table>' +
            '<div class="row"><button id="f-save" class="primary">Enregistrer</button><button id="f-cancel">Annuler</button><span id="f-status" class="status"></span></div></div>';
        var adminBox = document.getElementById('f-admin');
        var showRights = function () { document.getElementById('f-sites').style.opacity = adminBox.checked ? 0.4 : 1; };
        adminBox.addEventListener('change', showRights);
        showRights();
        document.getElementById('f-cancel').addEventListener('click', function () { form.innerHTML = ''; });
        document.getElementById('f-save').addEventListener('click', function () {
            var input = {
                username: document.getElementById('f-user').value.trim(), name: document.getElementById('f-name').value, email: document.getElementById('f-email').value,
                active: document.getElementById('f-active').checked, admin: adminBox.checked, defaultRole: document.getElementById('f-default').value, sites: {}, equipments: {}
            };
            var pass = document.getElementById('f-pass').value;
            if (pass) { input.password = pass; }
            if (document.getElementById('f-unlock') && document.getElementById('f-unlock').checked) { input.unlock = true; }
            sites.forEach(function (s, k) {
                var role = form.querySelector('[data-site="' + k + '"]').value;
                if (role) { input.sites[s.site] = role; }
                var eq = Array.prototype.filter.call(form.querySelectorAll('[data-eq="' + k + '"]'), function (c) { return c.checked; }).map(function (c) { return c.value; });
                if (eq.length) { input.equipments[s.site] = eq; }
            });
            var req = isNew ? api('POST', '/accounts/users', input) : api('PUT', '/accounts/users/' + encodeURIComponent(u.username), input);
            req.then(function () { form.innerHTML = ''; loadUsers(); }).catch(function (err) { status('f-status', err.message, true); });
        });
        form.scrollIntoView({ behavior: 'smooth' });
    }

    // ---------------------------------------------------------------- sessions
    function loadSessions() {
        var box = document.getElementById('tab-sessions');
        api('GET', '/accounts/sessions').then(function (r) {
            box.innerHTML = '<p class="info">Sessions ouvertes. Une session se ferme après l’inactivité ou la durée maximale réglées dans l’onglet Sécurité.</p>' +
                '<table><thead><tr><th>Utilisateur</th><th>Adresse</th><th>Ouverte le</th><th>Dernière activité</th><th>Expire</th><th>Navigateur</th><th></th></tr></thead><tbody>' +
                r.data.map(function (s) {
                    return '<tr><td>' + esc(s.user) + '</td><td>' + esc(s.ip) + '</td><td>' + date(s.created) + '</td><td>' + date(s.last) + '</td><td>' + date(s.expires) + '</td>' +
                        '<td><small>' + esc(s.agent) + '</small></td><td><button data-sid="' + esc(s.sid) + '">Fermer</button></td></tr>';
                }).join('') + '</tbody></table>';
            box.querySelector('tbody').addEventListener('click', function (e) {
                var sid = e.target.getAttribute('data-sid');
                if (sid) { api('DELETE', '/accounts/sessions/' + encodeURIComponent(sid)).then(loadSessions).catch(function (err) { alert(err.message); }); }
            });
        }).catch(function (err) { box.innerHTML = '<p class="error">' + esc(err.message) + '</p>'; });
    }

    // ---------------------------------------------------------------- journal
    function loadJournal() {
        var box = document.getElementById('tab-journal');
        if (!box.innerHTML) {
            box.innerHTML = '<div class="row"><select id="j-type"><option value="">Tous les types</option>' + Object.keys(TYPES).map(function (t) { return '<option value="' + t + '">' + TYPES[t][0] + '</option>'; }).join('') + '</select>' +
                '<select id="j-user"><option value="">Tous les utilisateurs</option>' + users.map(function (u) { return '<option>' + esc(u.username) + '</option>'; }).join('') + '</select>' +
                '<select id="j-site"><option value="">Tous les sites</option>' + sites.map(function (s) { return '<option>' + esc(s.site) + '</option>'; }).join('') + '</select>' +
                '<select id="j-days"><option value="1">24 dernières heures</option><option value="7" selected>7 derniers jours</option><option value="30">30 derniers jours</option></select>' +
                '<span id="j-status" class="status"></span></div><div class="scroll"><table><thead><tr><th>Date</th><th>Type</th><th>Utilisateur</th><th>Site</th><th>Action</th><th>Détail</th><th>Résultat</th></tr></thead><tbody id="j-rows"></tbody></table></div>';
            ['j-type', 'j-user', 'j-site', 'j-days'].forEach(function (id) { document.getElementById(id).addEventListener('change', loadJournal); });
        }
        var q = '?from=' + (Date.now() - Number(document.getElementById('j-days').value) * 86400000);
        ['type', 'user', 'site'].forEach(function (k) { var v = document.getElementById('j-' + k).value; if (v) { q += '&' + k + '=' + encodeURIComponent(v); } });
        api('GET', '/accounts/journal' + q).then(function (r) {
            document.getElementById('j-rows').innerHTML = r.data.map(function (e) {
                var t = TYPES[e.type] || [e.type, 'st-off'];
                var detail = e.type === 'consigne' ? esc(e.device || '') + ' / ' + esc(e.tag || '') + ' : ' + esc(e.old) + ' → ' + esc(e.value) + (e.detail ? ' (' + esc(e.detail) + ')' : '') : esc(e.detail || '');
                return '<tr><td>' + date(e.time) + '</td><td><span class="st ' + t[1] + '">' + t[0] + '</span></td><td>' + esc(e.user || '—') + '</td><td>' + esc(e.site || '') + '</td>' +
                    '<td>' + esc(e.action || '') + (e.ip ? '<br><small>' + esc(e.ip) + '</small>' : '') + '</td><td>' + detail + '</td>' +
                    '<td>' + (e.result === 'ok' ? '<span class="st st-ok">ok</span>' : e.result ? '<span class="st st-error">' + esc(e.result) + '</span>' : '') + '</td></tr>';
            }).join('') || '<tr><td colspan="7" class="info">Aucun événement.</td></tr>';
            status('j-status', r.meta.count + ' événement(s)' + (r.meta.count > r.data.length ? ' (' + r.data.length + ' affichés)' : ''));
        }).catch(function (err) { status('j-status', err.message, true); });
    }

    // ---------------------------------------------------------------- security
    function loadSecurity() {
        var box = document.getElementById('tab-security');
        api('GET', '/accounts/settings').then(function (r) {
            var s = r.data;
            box.innerHTML = '<div class="card"><h3>Sécurité des sites</h3>' +
                '<p class="info">Activée : connexion obligatoire pour l’éditeur, la supervision, les pages et l’API des sites, avec les droits de chaque compte. ' +
                'Désactivée : accès libre comme avant. Les opérations sensibles (suppression, restauration, sécurité) demandent de retaper le mot de passe.</p>' +
                '<div class="row"><label><input type="checkbox" id="x-enabled"' + (s.enabled ? ' checked' : '') + '> Sécurité activée</label>' +
                '<label>Fermeture après <input id="x-idle" size="4" value="' + s.idleMinutes + '"> min d’inactivité</label>' +
                '<label>Durée maximale d’une session <input id="x-hours" size="3" value="' + s.sessionHours + '"> h</label>' +
                '<label>Mot de passe : <input id="x-min" size="3" value="' + s.minPasswordLength + '"> caractères au moins</label></div>' +
                '<div class="row"><button id="x-save" class="primary">Enregistrer</button><span id="x-status" class="status">' +
                (s.enabled ? 'Sécurité activée.' : 'Sécurité désactivée : les sites sont accessibles sans connexion.') + '</span></div></div>';
            document.getElementById('x-save').addEventListener('click', function () {
                api('PUT', '/accounts/settings', {
                    enabled: document.getElementById('x-enabled').checked, idleMinutes: Number(document.getElementById('x-idle').value),
                    sessionHours: Number(document.getElementById('x-hours').value), minPasswordLength: Number(document.getElementById('x-min').value)
                }).then(function (res) { status('x-status', res.data.enabled ? 'Sécurité activée.' : 'Sécurité désactivée.'); })
                    .catch(function (err) { status('x-status', err.message, true); });
            });
        }).catch(function (err) { box.innerHTML = '<p class="error">' + esc(err.message) + '</p>'; });
    }

    // ---------------------------------------------------------------- start
    fetch('/api/v1/auth/status', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (r) {
        if (r.data.setup) { return setup(); }
        me = r.data.user;
        if (!me) {
            location.href = '/connexion?next=' + encodeURIComponent('/comptes');
            return null;
        }
        document.getElementById('who').textContent = (me.name || me.username) + (me.admin ? ' (administrateur)' : '');
        if (!me.admin) {
            app.innerHTML = '<p class="error">Page réservée aux administrateurs.</p>';
            return null;
        }
        main();
        return null;
    }).catch(function (err) { app.innerHTML = '<p class="error">' + esc(err.message) + '</p>'; });
})();
