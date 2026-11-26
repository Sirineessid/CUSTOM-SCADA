/**
 * custom-SCADA: page /alarmes of the main FUXA: alarms of all the sites (active, history, statistics) and Telegram notifications.
 * API /api/v1/alarms, /api/v1/alarms/history, /api/v1/alarms/stats, /api/v1/sites/{site}/alarms/.../ack, /api/v1/notifications.
 */
(function () {
    'use strict';

    var app = document.getElementById('app');
    var LEVELS = [['highhigh', 'Critique'], ['high', 'Haute'], ['low', 'Basse'], ['info', 'Information']];
    var LEVEL_NAME = { highhigh: 'Critique', high: 'Haute', low: 'Basse', info: 'Information' };
    var SOURCES = [['alarme', 'Seuils'], ['scenario', 'Scénarios'], ['communication', 'Communication']];

    var tab = 'active', timer = null, sites = [], history = [], notif = null, isAdmin = true, token = null;

    function esc(t) {
        return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
        });
    }

    function date(ms) {
        if (!ms) { return ''; }
        var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function duration(ms) {
        var s = Math.round(ms / 1000);
        if (s < 60) { return s + ' s'; }
        if (s < 3600) { return Math.floor(s / 60) + ' min ' + (s % 60) + ' s'; }
        return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
    }

    function status(id, text, error) {
        var el = document.getElementById(id);
        if (el) { el.textContent = text; el.className = 'status' + (error ? ' error' : ''); }
    }

    function badge(type) { return '<span class="lvl lvl-' + esc(type) + '">' + esc(LEVEL_NAME[type] || type) + '</span>'; }
    function srcBadge(a) { return a.source && a.source !== 'alarme' ? '<span class="src">' + esc(a.sourceText) + '</span>' : ''; }
    function value(v) { var n = Number(v); return v === null || v === undefined || v === '' ? '' : isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v); }
    function options(values, selected) {
        return values.map(function (v) { return '<option value="' + esc(v[0]) + '"' + (v[0] === selected ? ' selected' : '') + '>' + esc(v[1]) + '</option>'; }).join('');
    }

    /** API: 401 -> login page; 403 confirmation_required -> password typed again */
    function api(method, path, body, query) {
        var options = { method: method, credentials: 'same-origin', headers: {} };
        if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
        var qs = query ? Object.keys(query).filter(function (k) { return query[k] !== '' && query[k] !== undefined && query[k] !== null; })
            .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); }).join('&') : '';
        return fetch('/api/v1' + path + (qs ? '?' + qs : ''), options).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (b) {
                if (r.status === 401 && b.error && /login_required|session_expired/.test(b.error.code)) {
                    location.href = '/connexion?next=' + encodeURIComponent('/alarmes') + (b.error.code === 'session_expired' ? '&expire=1' : '');
                    throw new Error(b.error.message);
                }
                if (r.status === 403 && b.error && b.error.code === 'confirmation_required') {
                    var password = prompt('Opération sensible : confirmer votre mot de passe');
                    if (!password) { throw new Error('Opération annulée.'); }
                    return api('POST', '/auth/confirm', { password: password }).then(function () { return api(method, path, body, query); });
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

    app.innerHTML =
        '<div class="cards" id="a-sites"></div>' +
        '<div class="tabs"><button data-tab="active" class="on">Alarmes actives</button><button data-tab="history">Historique</button>' +
        '<button data-tab="stats">Statistiques</button><button data-tab="notif" id="tab-notif-btn">Notifications Telegram</button></div>' +
        '<div class="row" id="filters"><select id="f-site"><option value="">Tous les sites</option></select>' +
        LEVELS.map(function (l) { return '<label><input type="checkbox" class="f-level" value="' + l[0] + '" checked> ' + l[1] + '</label>'; }).join('') +
        '<select id="f-source"><option value="">Toutes les sources</option>' + options(SOURCES) + '</select>' +
        '<input id="f-text" size="18" placeholder="Texte du message">' +
        '<span id="f-period" style="display:none">Du <input type="datetime-local" id="f-from"> au <input type="datetime-local" id="f-to"> ' +
        '<button data-hours="24">24 h</button><button data-hours="168">7 j</button><button data-hours="720">30 j</button> <button id="f-show" class="primary">Afficher</button></span></div>' +
        '<div id="tab-active"><div class="row"><span id="a-status" class="status"></span></div>' +
        '<div class="scroll"><table><thead><tr><th>Site</th><th>Priorité</th><th>Début</th><th>Équipement</th><th>Tag</th><th>Message</th><th>Valeur</th><th>État</th><th>Acquittement</th><th></th></tr></thead>' +
        '<tbody id="a-rows"></tbody></table></div></div>' +
        '<div id="tab-history" style="display:none"><div class="row"><button id="h-csv">Exporter en CSV</button><span id="h-status" class="status"></span></div>' +
        '<div class="scroll"><table><thead><tr><th>Site</th><th>Priorité</th><th>Début</th><th>Fin</th><th>Durée</th><th>Acquittement</th><th>Équipement</th><th>Message</th><th>État</th></tr></thead>' +
        '<tbody id="h-rows"></tbody></table></div></div>' +
        '<div id="tab-stats" style="display:none"><div class="row"><span id="st-status" class="status"></span></div><div class="cards" id="st-cards"></div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:30px"><div><h3>Par site</h3><div id="st-sites"></div></div><div><h3>Par équipement</h3><div id="st-devices"></div></div>' +
        '<div><h3>Par jour</h3><div id="st-days"></div></div></div>' +
        '<h3>Alarmes les plus fréquentes</h3><div class="scroll"><table><thead><tr><th>Site</th><th>Priorité</th><th>Message</th><th>Source</th><th>Équipement</th><th>Nombre</th><th>Durée totale</th><th>Acquittées</th><th>Dernière</th></tr></thead>' +
        '<tbody id="st-rows"></tbody></table></div></div>' +
        '<div id="tab-notif" style="display:none"></div>';

    // ---------------------------------------------------------------- filters
    var relativeHours = 24;
    function local(ms) {
        var d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
        return d.toISOString().slice(0, 16);
    }
    function setPeriod(hours) {
        relativeHours = hours;
        document.getElementById('f-to').value = local(Date.now());
        document.getElementById('f-from').value = local(Date.now() - hours * 3600000);
    }
    function filters(withPeriod) {
        var levels = Array.prototype.filter.call(document.querySelectorAll('.f-level'), function (c) { return c.checked; }).map(function (c) { return c.value; });
        var f = {
            site: document.getElementById('f-site').value, source: document.getElementById('f-source').value,
            type: levels.length === LEVELS.length ? '' : (levels.join(',') || 'none'), text: document.getElementById('f-text').value.trim()
        };
        if (withPeriod) {
            if (relativeHours) {
                setPeriod(relativeHours);
                f.to = Date.now();
                f.from = f.to - relativeHours * 3600000;
            } else {
                f.from = new Date(document.getElementById('f-from').value).getTime();
                f.to = new Date(document.getElementById('f-to').value).getTime();
            }
        }
        return f;
    }
    function refresh() {
        if (tab === 'active') { loadActive(); }
        if (tab === 'history') { loadHistory(); }
        if (tab === 'stats') { loadStats(); }
    }
    ['f-site', 'f-source'].forEach(function (id) { document.getElementById(id).addEventListener('change', refresh); });
    document.querySelectorAll('.f-level').forEach(function (c) { c.addEventListener('change', refresh); });
    var textTimer = null;
    document.getElementById('f-text').addEventListener('input', function () { clearTimeout(textTimer); textTimer = setTimeout(refresh, 400); });
    ['f-from', 'f-to'].forEach(function (id) { document.getElementById(id).addEventListener('change', function () { relativeHours = null; }); });
    document.querySelectorAll('#f-period [data-hours]').forEach(function (b) {
        b.addEventListener('click', function () { setPeriod(Number(b.getAttribute('data-hours'))); refresh(); });
    });
    document.getElementById('f-show').addEventListener('click', refresh);

    function errorsText(meta) {
        return meta.errors && meta.errors.length ? ' Sites sans réponse : ' + meta.errors.map(function (e) { return e.site_id + ' (' + e.error + ')'; }).join(', ') + '.' : '';
    }

    // ---------------------------------------------------------------- active alarms
    function drawSites(meta) {
        document.getElementById('a-sites').innerHTML = meta.sites.map(function (s) {
            var c = s.counts;
            return '<div class="card"><a href="/site/' + encodeURIComponent(s.site_id) + '/fichiers/alarmes.html">' + esc(s.site_id) +
                (c ? '<b class="' + (c.highhigh ? 'bad' : '') + '">' + s.count + '</b><small>' + c.highhigh + ' critique(s), ' + c.toack + ' à acquitter</small>'
                    : '<b>—</b><small>' + esc(s.error) + '</small>') + '</a></div>';
        }).join('') || '<p class="info">Aucun site.</p>';
    }

    function loadActive() {
        var f = filters(false);
        if (f.type === 'none') { document.getElementById('a-rows').innerHTML = '<tr><td colspan="10" class="empty">Aucune priorité cochée.</td></tr>'; return; }
        var site = f.site;
        delete f.site;
        // the cards of the sites show all the sites, the table the site chosen
        api('GET', '/alarms', undefined, f).then(function (r) {
            drawSites(r.meta);
            var list = r.data.filter(function (a) { return !site || a.site_id === site; });
            document.getElementById('a-rows').innerHTML = list.map(function (a) {
                return '<tr class="' + (a.critical ? 'row-critical' : '') + '"><td>' + esc(a.site_id) + '</td><td>' + badge(a.type) + '</td><td>' + date(a.ontime) + '</td>' +
                    '<td>' + esc(a.device) + '</td><td>' + esc(a.tag) + '</td><td>' + esc(a.text) + srcBadge(a) + '</td><td>' + esc(value(a.value)) + '</td><td>' + esc(a.statusText) + '</td>' +
                    '<td>' + (a.acktime ? date(a.acktime) + (a.userack ? ' (' + esc(a.userack) + ')' : '') : '') + '</td>' +
                    '<td>' + (a.toack ? '<button data-site="' + esc(a.site_id) + '" data-ack="' + esc(a.alarm_id) + '">Acquitter</button>' : '') + '</td></tr>';
            }).join('') || '<tr><td colspan="10" class="empty">Aucune alarme active.</td></tr>';
            status('a-status', list.length + ' alarme(s) active(s), mise à jour ' + date(r.meta.time).slice(11) + '.' + errorsText(r.meta), r.meta.errors.length > 0);
        }).catch(function (err) { status('a-status', err.message, true); });
    }

    document.getElementById('a-rows').addEventListener('click', function (e) {
        var id = e.target.getAttribute('data-ack'), site = e.target.getAttribute('data-site');
        if (!id) { return; }
        api('POST', '/sites/' + encodeURIComponent(site) + '/alarms/' + encodeURIComponent(id) + '/ack').then(loadActive).catch(function (err) { status('a-status', err.message, true); });
    });

    // ---------------------------------------------------------------- history
    function loadHistory() {
        var f = filters(true);
        if (f.type === 'none') { document.getElementById('h-rows').innerHTML = '<tr><td colspan="9" class="empty">Aucune priorité cochée.</td></tr>'; return; }
        status('h-status', 'Chargement...');
        var t = token = {};
        api('GET', '/alarms/history', undefined, f).then(function (r) {
            if (t !== token) { return; }
            history = r.data;
            document.getElementById('h-rows').innerHTML = history.slice(0, 2000).map(function (a) {
                return '<tr class="' + (a.critical ? 'row-critical' : '') + '"><td>' + esc(a.site_id) + '</td><td>' + badge(a.type) + '</td><td>' + date(a.ontime) + '</td><td>' + date(a.offtime) + '</td>' +
                    '<td>' + (a.ontime ? duration((a.offtime || Date.now()) - a.ontime) : '') + '</td><td>' + (a.acktime ? date(a.acktime) + (a.userack ? ' (' + esc(a.userack) + ')' : '') : '') + '</td>' +
                    '<td>' + esc(a.device) + '</td><td>' + esc(a.text) + srcBadge(a) + '</td><td>' + esc(a.statusText) + '</td></tr>';
            }).join('') || '<tr><td colspan="9" class="empty">Aucune alarme sur cette période.</td></tr>';
            var c = r.meta.counts;
            status('h-status', history.length + ' alarme(s) : ' + c.highhigh + ' critique(s), ' + c.high + ' haute(s), ' + c.low + ' basse(s), ' + c.info + ' information(s).' +
                (history.length > 2000 ? ' 2000 premières affichées, toutes dans le CSV.' : '') + errorsText(r.meta), r.meta.errors.length > 0);
        }).catch(function (err) { status('h-status', err.message, true); });
    }

    document.getElementById('h-csv').addEventListener('click', function () {
        var head = ['Site', 'Priorité', 'Début', 'Fin', 'Durée', 'Acquittement', 'Utilisateur', 'Équipement', 'Tag', 'Message', 'Source', 'Valeur', 'État'];
        var rows = history.map(function (a) {
            return [a.site_id, LEVEL_NAME[a.type] || a.type, date(a.ontime), date(a.offtime), a.ontime ? duration((a.offtime || Date.now()) - a.ontime) : '', date(a.acktime), a.userack || '',
                a.device || '', a.tag || '', a.text, a.sourceText || '', value(a.value), a.statusText];
        });
        var csv = [head].concat(rows).map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';'); }).join('\r\n');
        var link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
        link.download = 'alarmes-sites.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
    });

    // ---------------------------------------------------------------- statistics
    function bars(list, key) {
        var max = Math.max.apply(null, list.map(function (x) { return x.count; }).concat([1]));
        return list.slice(0, 15).map(function (x) {
            return '<div class="hbar"><span>' + esc(x[key]) + '</span><i style="width:' + Math.round(x.count / max * 220) + 'px"></i><b>' + x.count + '</b></div>';
        }).join('') || '<p class="empty">Aucune alarme.</p>';
    }

    function loadStats() {
        var f = filters(true);
        if (f.type === 'none') { status('st-status', 'Aucune priorité cochée.', true); return; }
        status('st-status', 'Chargement...');
        var t = token = {};
        api('GET', '/alarms/stats', undefined, f).then(function (r) {
            if (t !== token) { return; }
            var d = r.data;
            var card = function (title, v, bad) { return '<div class="card">' + esc(title) + '<b class="' + (bad ? 'bad' : '') + '">' + v + '</b></div>'; };
            document.getElementById('st-cards').innerHTML = card('Alarmes sur la période', d.total) +
                LEVELS.map(function (l) { return card(l[1], d.byLevel[l[0]] || 0, l[0] === 'highhigh' && d.byLevel.highhigh); }).join('') +
                Object.keys(d.bySource).map(function (k) { return card('Source : ' + k, d.bySource[k]); }).join('');
            document.getElementById('st-sites').innerHTML = bars(d.bySite, 'site_id');
            document.getElementById('st-devices').innerHTML = bars(d.byDevice, 'device');
            document.getElementById('st-days').innerHTML = bars(d.byDay.map(function (x) { return { day: x.day.split('-').reverse().join('/'), count: x.count }; }), 'day');
            document.getElementById('st-rows').innerHTML = d.top.map(function (a) {
                return '<tr><td>' + esc(a.site_id) + '</td><td>' + badge(a.type) + '</td><td>' + esc(a.text) + '</td><td>' + esc(a.sourceText) + '</td><td>' + esc(a.device) + '</td>' +
                    '<td><b>' + a.count + '</b></td><td>' + duration(a.duration) + '</td><td>' + a.acknowledged + ' / ' + a.count + '</td><td>' + date(a.last) + '</td></tr>';
            }).join('') || '<tr><td colspan="9" class="empty">Aucune alarme sur cette période.</td></tr>';
            status('st-status', d.total + ' alarme(s) du ' + date(f.from) + ' au ' + date(f.to) + '.' + errorsText(r.meta), r.meta.errors.length > 0);
        }).catch(function (err) { status('st-status', err.message, true); });
    }

    // ---------------------------------------------------------------- notifications
    function ruleRow(r, i) {
        return '<tr><td><input type="checkbox" data-on="' + i + '"' + (r.enabled ? ' checked' : '') + '></td><td>' + esc(r.name) + '</td>' +
            '<td>' + (r.sites.length ? esc(r.sites.join(', ')) : 'tous') + '</td><td>' + r.levels.map(badge).join(' ') + '</td>' +
            '<td>' + esc(SOURCES.filter(function (s) { return r.sources.indexOf(s[0]) >= 0; }).map(function (s) { return s[1]; }).join(', ')) + '</td>' +
            '<td>' + esc(r.recipients.join(', ')) + '</td>' +
            '<td>' + (r.onEnd ? 'début et fin' : 'début') + '</td><td><button data-redit="' + i + '">Modifier</button> <button data-rdel="' + i + '">Supprimer</button></td></tr>';
    }

    function loadNotif() {
        var box = document.getElementById('tab-notif');
        Promise.all([api('GET', '/notifications'), api('GET', '/notifications/history', undefined, { limit: 100 })]).then(function (res) {
            notif = res[0].data;
            var st = res[0].meta;
            box.innerHTML =
                '<fieldset><legend>Bot Telegram</legend><div class="row"><label class="blk"><input type="checkbox" id="n-enabled"' + (notif.enabled ? ' checked' : '') + '> Notifications activées</label>' +
                '<label class="blk">Jeton du bot <input id="n-token" type="password" size="40" value="' + esc(notif.telegram.token) + '" placeholder="123456789:ABC..." autocomplete="new-password"></label>' +
                '<label class="blk">Regroupement <input type="number" id="n-group" min="0" max="3600" style="width:70px" value="' + esc(notif.groupDelay) + '"> s</label>' +
                '<label class="blk">Préfixe <input id="n-prefix" size="10" value="' + esc(notif.prefix) + '"></label></div>' +
                '<div class="row"><button id="n-save" class="primary">Enregistrer</button><input id="n-to" size="22" placeholder="chat pour le message de test"><button id="n-test">Envoyer un message de test</button>' +
                '<span id="n-status" class="status"></span></div>' +
                '<p class="info">Gratuit. Créer le bot avec @BotFather dans Telegram (il donne le jeton). Chat : identifiant de la personne ou du groupe (négatif pour un groupe, donné par exemple par @userinfobot), ou @canal. ' +
                'Chaque personne doit ouvrir le bot et appuyer sur Démarrer une fois ; pour un groupe, ajouter le bot au groupe.</p>' +
                '<p class="info">Lecture des alarmes toutes les 10 s : ' + (st.lastPoll.time ? date(st.lastPoll.time) + ' (' + Object.keys(st.lastPoll.sites).map(function (k) { return esc(k) + ' : ' + esc(st.lastPoll.sites[k]); }).join(', ') + ')' : 'pas encore') +
                '. Les alarmes déjà actives au démarrage du serveur ne sont pas envoyées.</p></fieldset>' +
                '<fieldset><legend>Règles : qui reçoit quoi</legend><div class="row"><button id="r-new" class="primary">+ Nouvelle règle</button><span id="r-status" class="status"></span></div><div id="r-form"></div>' +
                '<table><thead><tr><th>Active</th><th>Nom</th><th>Sites</th><th>Priorités</th><th>Sources</th><th>Destinataires</th><th>Envoi</th><th></th></tr></thead><tbody id="r-rows">' +
                (notif.rules.map(ruleRow).join('') || '<tr><td colspan="8" class="empty">Aucune règle : aucun message envoyé.</td></tr>') + '</tbody></table></fieldset>' +
                '<fieldset><legend>Derniers envois</legend><div class="scroll" style="max-height:320px"><table><thead><tr><th>Heure</th><th>Destinataire</th><th>Objet</th><th>Alarmes</th><th>Résultat</th></tr></thead><tbody>' +
                (res[1].data.map(function (e) {
                    var cls = e.status === 'échec' ? 'st-error' : 'st-ok';
                    return '<tr><td>' + date(e.time) + '</td><td>' + esc(e.to) + '</td><td>' + esc(e.subject) + '</td><td>' + (e.test ? 'test' : e.count) + '</td>' +
                        '<td><span class="st ' + cls + '">' + esc(e.status) + '</span>' + (e.error ? ' ' + esc(e.error) : '') + '</td></tr>';
                }).join('') || '<tr><td colspan="5" class="empty">Aucun envoi.</td></tr>') + '</tbody></table></div></fieldset>';
            document.getElementById('n-save').addEventListener('click', function () { saveNotif({}, 'n-status', 'Paramètres enregistrés.'); });
            document.getElementById('n-test').addEventListener('click', function () {
                status('n-status', 'Envoi...');
                saveNotif({}, 'n-status', '').then(function () {
                    return api('POST', '/notifications/test', { to: document.getElementById('n-to').value });
                }).then(function (r) {
                    var e = r.data[0];
                    status('n-status', e.status === 'échec' ? 'Échec : ' + e.error : 'Message de test ' + e.status + '.', e.status === 'échec');
                }).catch(function (err) { status('n-status', err.message, true); });
            });
            document.getElementById('r-new').addEventListener('click', function () { editRule(null); });
            document.getElementById('r-rows').addEventListener('click', function (e) {
                var edit = e.target.getAttribute('data-redit'), del = e.target.getAttribute('data-rdel'), on = e.target.getAttribute('data-on');
                var rules = notif.rules.slice();
                if (edit !== null) { editRule(Number(edit)); }
                if (del !== null && confirm('Supprimer la règle « ' + rules[Number(del)].name + ' » ?')) {
                    rules.splice(Number(del), 1);
                    saveNotif({ rules: rules }, 'r-status', 'Règle supprimée.').then(loadNotif);
                }
                if (on !== null) {
                    rules[Number(on)] = Object.assign({}, rules[Number(on)], { enabled: e.target.checked });
                    saveNotif({ rules: rules }, 'r-status', 'Règle ' + (e.target.checked ? 'activée.' : 'désactivée.')).then(loadNotif);
                }
            });
        }).catch(function (err) {
            box.innerHTML = '<p class="error">' + esc(err.message) + '</p>';
        });
    }

    function saveNotif(extra, statusId, message) {
        var input = Object.assign({
            enabled: document.getElementById('n-enabled').checked, groupDelay: Number(document.getElementById('n-group').value),
            prefix: document.getElementById('n-prefix').value, telegram: { token: document.getElementById('n-token').value }
        }, extra);
        return api('PUT', '/notifications', input).then(function (r) {
            notif = r.data;
            if (message) { status(statusId, message); }
            return r;
        }).catch(function (err) { status(statusId, err.message, true); throw err; });
    }

    function editRule(index) {
        var r = index === null ? { name: '', enabled: true, sites: [], levels: ['highhigh', 'high'], sources: ['alarme', 'scenario', 'communication'], recipients: [], onEnd: false }
            : notif.rules[index];
        var form = document.getElementById('r-form');
        var check = function (cls, list, values) {
            return list.map(function (v) { return '<label class="blk"><input type="checkbox" class="' + cls + '" value="' + esc(v[0]) + '"' + (values.indexOf(v[0]) >= 0 ? ' checked' : '') + '> ' + esc(v[1]) + '</label>'; }).join('');
        };
        form.innerHTML = '<div class="card"><h3>' + (index === null ? 'Nouvelle règle' : 'Modifier « ' + esc(r.name) + ' »') + '</h3>' +
            '<div class="row"><label class="blk">Nom <input id="re-name" size="30" value="' + esc(r.name) + '" placeholder="Astreinte exploitation"></label></div>' +
            '<div class="row"><b>Sites</b> (aucun coché = tous) ' + check('re-site', sites.map(function (s) { return [s, s]; }), r.sites) + '</div>' +
            '<div class="row"><b>Priorités</b> ' + check('re-level', LEVELS, r.levels) + '</div>' +
            '<div class="row"><b>Sources</b> ' + check('re-source', SOURCES, r.sources) + '</div>' +
            '<div class="row"><label class="blk">Chats Telegram <input id="re-to" size="50" value="' + esc(r.recipients.join(', ')) + '" placeholder="123456789, -1001234567890"></label></div>' +
            '<div class="row"><label class="blk"><input type="checkbox" id="re-end"' + (r.onEnd ? ' checked' : '') + '> envoyer aussi la fin des alarmes</label></div>' +
            '<div class="row"><button id="re-save" class="primary">Enregistrer</button><button id="re-cancel">Annuler</button><span id="re-status" class="status"></span></div></div>';
        var values = function (cls) { return Array.prototype.filter.call(form.querySelectorAll('.' + cls), function (c) { return c.checked; }).map(function (c) { return c.value; }); };
        document.getElementById('re-cancel').addEventListener('click', function () { form.innerHTML = ''; });
        document.getElementById('re-save').addEventListener('click', function () {
            var rule = {
                id: r.id, enabled: r.enabled, name: document.getElementById('re-name').value.trim(), sites: values('re-site'), levels: values('re-level'), sources: values('re-source'),
                recipients: document.getElementById('re-to').value,
                onEnd: document.getElementById('re-end').checked
            };
            var rules = notif.rules.slice();
            if (index === null) { rules.push(rule); } else { rules[index] = rule; }
            saveNotif({ rules: rules }, 're-status', '').then(function () { loadNotif(); }).catch(function () { /* message shown */ });
        });
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ---------------------------------------------------------------- tabs
    function showTab(name) {
        tab = name;
        document.querySelectorAll('.tabs button').forEach(function (b) { b.className = b.getAttribute('data-tab') === name ? 'on' : ''; });
        ['active', 'history', 'stats', 'notif'].forEach(function (t) { document.getElementById('tab-' + t).style.display = t === name ? '' : 'none'; });
        document.getElementById('filters').style.display = name === 'notif' ? 'none' : '';
        document.getElementById('f-period').style.display = name === 'history' || name === 'stats' ? '' : 'none';
        clearInterval(timer);
        loadActive();
        timer = setInterval(function () { if (!document.hidden) { loadActive(); } }, 5000);
        if (name === 'history') { loadHistory(); }
        if (name === 'stats') { loadStats(); }
        if (name === 'notif') { loadNotif(); }
    }
    document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });

    setPeriod(24);
    api('GET', '/auth/status').then(function (r) {
        var d = r.data;
        if (d.enabled && d.user) {
            document.getElementById('who').textContent = d.user.name || d.user.username;
            document.getElementById('logout').style.display = '';
            isAdmin = !!d.user.admin;
        }
        if (!isAdmin) { document.getElementById('tab-notif-btn').style.display = 'none'; }
        return api('GET', '/sites');
    }).then(function (r) {
        sites = r.data.map(function (s) { return s.site_id; });
        document.getElementById('f-site').innerHTML = '<option value="">Tous les sites</option>' + sites.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('');
        var hash = { '#historique': 'history', '#statistiques': 'stats', '#notifications': 'notif' }[location.hash];
        showTab(hash && (hash !== 'notif' || isAdmin) ? hash : 'active');
    }).catch(function (err) { status('a-status', err.message, true); });
})();
