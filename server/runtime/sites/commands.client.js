/**
 * custom-SCADA: commandes.js, page Commandes of a site (commandes.html): remote commands of the equipments
 * (marche / arrêt, mode auto / manuel, consignes) with confirmation, interlocks and feedback, history of the commands,
 * and configuration of the commands (engineers). Uses the API v1 of the site with site-api.js; the page has <div id="commands-app">.
 */
(function () {
    'use strict';

    var app = document.getElementById('commands-app');
    var TYPES = [['onoff', 'Marche / arrêt'], ['mode', 'Mode auto / manuel'], ['setpoint', 'Consigne']];
    var OPS = [['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['=', '='], ['!=', '≠']];
    var ROLES = [['operateur', 'opérateur'], ['ingenieur', 'ingénieur'], ['administrateur', 'administrateur']];
    var WHEN = { onoff: [['on', 'la marche'], ['off', 'l’arrêt'], ['all', 'les deux']], mode: [['on', 'le mode auto'], ['off', 'le mode manuel'], ['all', 'les deux']] };
    var STATUS = { 'exécutée': 'st-ok', 'envoyée': 'st-info', 'en cours': 'st-info', 'refusée': 'st-error', 'expirée': 'st-warning', 'échec': 'st-error' };
    var tab = 'control', timer = null, tags = [], commands = [], config = [], history = [], relativeHours = 24;

    function esc(t) {
        return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
        });
    }
    function date(ms) { return ms ? SiteApi.formatDate(ms, true) : ''; }
    function status(id, text, error) {
        var el = document.getElementById(id);
        if (el) { el.textContent = text; el.className = 'status' + (error ? ' error' : ''); }
    }
    function options(values, selected) {
        return values.map(function (v) { return '<option value="' + esc(v[0]) + '"' + (v[0] === selected ? ' selected' : '') + '>' + esc(v[1]) + '</option>'; }).join('');
    }
    function stBadge(s) { return '<span class="st ' + (STATUS[s] || 'st-off') + '">' + esc(s) + '</span>'; }
    function seconds(ms) { return ms === null || ms === undefined ? '' : (Math.round(ms / 100) / 10) + ' s'; }

    app.innerHTML =
        '<div class="tabs"><button data-tab="control" class="on">Commandes</button><button data-tab="history">Historique</button><button data-tab="config">Configuration</button></div>' +
        '<div id="tab-control"><div class="period"><span id="k-status" class="status"></span></div><div id="k-groups"></div></div>' +
        '<div id="tab-history" style="display:none"><div class="period">' +
        '<select id="h-status"><option value="">Tous les résultats</option><option>exécutée</option><option>envoyée</option><option>refusée</option><option>expirée</option><option>échec</option></select>' +
        '<select id="h-command"><option value="">Toutes les commandes</option></select>' +
        '<button data-hours="24">24 h</button><button data-hours="168">7 j</button><button data-hours="720">30 j</button><button id="h-csv">Exporter en CSV</button><span id="h-status-text" class="status"></span></div>' +
        '<div class="history"><table><thead><tr><th>Heure</th><th>Opérateur</th><th>Équipement</th><th>Commande</th><th>Valeur</th><th>Résultat</th><th>Motif</th><th>Retour d’état</th><th>Durée</th></tr></thead>' +
        '<tbody id="h-rows"></tbody></table></div></div>' +
        '<div id="tab-config" style="display:none"><p class="info">Une commande écrit un tag de l’équipement, puis surveille son retour d’état (tag de retour) pendant le délai choisi : ' +
        'exécutée si le retour donne la valeur demandée, sinon expirée. Les verrouillages bloquent la commande quand leur condition est vraie (par exemple « pompe en défaut »). ' +
        'Commande sensible : confirmation avant l’envoi ; commande critique : mot de passe redemandé. Configuration réservée aux ingénieurs.</p>' +
        '<div class="period"><button id="c-new" class="primary">+ Nouvelle commande</button><button id="c-preset">Ajouter les commandes type « station de pompage »</button><span id="c-status" class="status"></span></div>' +
        '<div id="c-form"></div>' +
        '<table><thead><tr><th>Actif</th><th>Équipement</th><th>Commande</th><th>Type</th><th>Tag / retour</th><th>Sécurité</th><th>Verrouillages</th><th></th></tr></thead><tbody id="c-rows"></tbody></table></div>';

    // ---------------------------------------------------------------- commands
    function card(c) {
        var locked = c.interlocksActive.length > 0;
        var disabled = !c.allowed || !c.connected || !c.enabled || !!c.pending;
        var dis = disabled ? ' disabled' : '';
        var btns;
        if (c.type === 'setpoint') {
            btns = '<input type="number" step="any" id="v-' + esc(c.id) + '" style="width:100px" value="' + esc(c.value === null ? '' : c.value) + '"' +
                (c.min !== null ? ' min="' + c.min + '"' : '') + (c.max !== null ? ' max="' + c.max + '"' : '') + dis + '> ' + esc(c.unit) +
                ' <button data-cmd="' + esc(c.id) + '" data-input="1" class="primary"' + dis + '>Envoyer</button>';
        } else {
            btns = '<button data-cmd="' + esc(c.id) + '" data-value="1" class="' + (c.value === 1 ? 'primary' : '') + '"' + dis + '>' + esc(c.labels[1]) + '</button>' +
                '<button data-cmd="' + esc(c.id) + '" data-value="0" class="' + (c.value === 0 ? 'primary' : '') + '"' + dis + '>' + esc(c.labels[0]) + '</button>';
        }
        var left = c.pending ? Math.max(0, Math.round((c.pending.until - Date.now()) / 1000)) : 0;
        return '<div class="cmd-card' + (locked ? ' locked' : '') + (!c.enabled || !c.connected ? ' off' : '') + '">' +
            '<h3>' + esc(c.name) + '</h3><div class="eq">' + esc(c.equipment || c.device) + ' · ' + esc(c.tagName) +
            (c.critical ? ' · <b>critique</b>' : c.confirm ? ' · sensible' : '') + '</div>' +
            '<div class="state">Commande : <b>' + esc(c.valueText || '—') + '</b>' + (c.feedbackTagName ? ' &nbsp; Retour : <b>' + esc(c.feedbackText === null ? '—' : c.feedbackText) + '</b>' : '') + '</div>' +
            (c.connected ? '' : '<div class="lock">Équipement non connecté</div>') +
            c.interlocksActive.map(function (l) { return '<div class="lock">🔒 ' + esc(l.text) + (l.when !== 'all' && c.type !== 'setpoint' ? ' (bloque ' + esc((WHEN[c.type].filter(function (w) { return w[0] === l.when; })[0] || [])[1]) + ')' : '') + '</div>'; }).join('') +
            (c.allowed ? '' : '<div class="lock">Non autorisé : ' + esc(c.notAllowedReason) + '</div>') +
            (c.enabled ? '' : '<div class="lock">Commande désactivée</div>') +
            (c.pending ? '<div class="wait">⏳ ' + esc(c.pending.valueText) + ' envoyée par ' + esc(c.pending.user || 'anonyme') + ', attente du retour d’état (' + left + ' s)</div>' : '') +
            '<div class="btns">' + btns + '</div></div>';
    }

    function loadCommands() {
        SiteApi.request('GET', '/commands').then(function (r) {
            commands = r.data;
            var groups = {};
            commands.forEach(function (c) { var g = c.equipment || c.device || 'Autres'; (groups[g] = groups[g] || []).push(c); });
            document.getElementById('k-groups').innerHTML = Object.keys(groups).map(function (g) {
                return '<h3>' + esc(g) + '</h3><div class="cmd-grid">' + groups[g].map(card).join('') + '</div>';
            }).join('') || '<p class="empty">Aucune commande configurée : onglet Configuration.</p>';
            var waiting = commands.filter(function (c) { return c.pending; }).length;
            if (!document.getElementById('k-status').dataset.keep) {
                status('k-status', commands.length + ' commande(s)' + (waiting ? ', ' + waiting + ' en attente du retour d’état' : '') + (r.meta.user ? ' · utilisateur ' + r.meta.user : '') + ', mise à jour ' + date(r.meta.time).slice(11));
            }
        }).catch(function (err) { status('k-status', err.message, true); });
    }

    function message(text, error) {
        var el = document.getElementById('k-status');
        el.dataset.keep = '1';
        status('k-status', text, error);
        clearTimeout(message.t);
        message.t = setTimeout(function () { delete el.dataset.keep; }, 8000);
    }

    function follow(execId) {
        var tries = 0;
        var step = function () {
            SiteApi.request('GET', '/commands/executions/' + encodeURIComponent(execId)).then(function (r) {
                var x = r.data;
                if (x.status === 'en cours' && tries++ < 7200) { setTimeout(step, 1000); loadCommands(); return; }
                message(x.name + ' : ' + x.valueText + ' → ' + x.status + (x.reason ? ' (' + x.reason + ')' : '') + (x.duration !== null ? ' en ' + seconds(x.duration) : ''), x.status !== 'exécutée' && x.status !== 'envoyée');
                loadCommands();
            }).catch(function (err) { message(err.message, true); });
        };
        step();
    }

    document.getElementById('k-groups').addEventListener('click', function (e) {
        var id = e.target.getAttribute('data-cmd');
        if (!id) { return; }
        var c = commands.filter(function (x) { return x.id === id; })[0];
        var value = e.target.getAttribute('data-input') ? document.getElementById('v-' + id).value : Number(e.target.getAttribute('data-value'));
        if (value === '' || value === null) { message('Écrire la valeur de la consigne.', true); return; }
        var text = c.type === 'setpoint' ? value + (c.unit ? ' ' + c.unit : '') : c.labels[Number(value)];
        if (c.confirm && !confirm('Confirmer la commande ?\n\n' + c.name + ' : ' + text + '\nÉquipement : ' + (c.equipment || c.device) + (c.critical ? '\n\nCommande critique : votre mot de passe sera demandé.' : ''))) {
            return;
        }
        message('Envoi de ' + c.name + ' : ' + text + '...');
        SiteApi.request('POST', '/commands/' + encodeURIComponent(id) + '/execute', { value: Number(value), confirmed: true }).then(function (r) {
            if (r.data.status === 'en cours') {
                message(c.name + ' : ' + text + ' envoyée, attente du retour d’état...');
                follow(r.data.id);
            } else {
                message(c.name + ' : ' + text + ' → ' + r.data.status + (r.data.reason ? ' (' + r.data.reason + ')' : ''));
            }
            loadCommands();
        }).catch(function (err) { message(err.message, true); loadCommands(); });
    });

    // ---------------------------------------------------------------- history
    function loadHistory() {
        var to = Date.now();
        var params = { from: to - relativeHours * 3600000, to: to, status: document.getElementById('h-status').value, command: document.getElementById('h-command').value };
        status('h-status-text', 'Chargement...');
        SiteApi.request('GET', '/commands/history', undefined, params).then(function (r) {
            history = r.data;
            document.getElementById('h-rows').innerHTML = history.map(function (x) {
                return '<tr><td>' + date(x.time) + '</td><td>' + esc(x.user || 'anonyme') + (x.role ? ' <small>(' + esc(x.role) + ')</small>' : '') + '</td><td>' + esc(x.equipment) + '</td>' +
                    '<td>' + esc(x.name) + '</td><td>' + esc(x.valueText) + '</td><td>' + stBadge(x.status) + '</td><td>' + esc(x.reason || '') + '</td>' +
                    '<td>' + (x.feedbackTag ? esc(x.feedbackTag) + ' = ' + esc(x.feedback === null ? '?' : x.feedback) : '') + '</td><td>' + seconds(x.duration) + '</td></tr>';
            }).join('') || '<tr><td colspan="9" class="empty">Aucune commande sur cette période.</td></tr>';
            var c = r.meta.counts;
            status('h-status-text', r.meta.count + ' commande(s) : ' + c.executed + ' exécutée(s), ' + c.sent + ' envoyée(s) sans retour, ' + c.refused + ' refusée(s), ' + c.expired + ' expirée(s), ' + c.failed + ' en échec');
        }).catch(function (err) { status('h-status-text', err.message, true); });
    }
    document.querySelectorAll('#tab-history [data-hours]').forEach(function (b) {
        b.addEventListener('click', function () { relativeHours = Number(b.getAttribute('data-hours')); loadHistory(); });
    });
    ['h-status', 'h-command'].forEach(function (id) { document.getElementById(id).addEventListener('change', loadHistory); });
    document.getElementById('h-csv').addEventListener('click', function () {
        var head = ['Heure', 'Opérateur', 'Rôle', 'Équipement', 'Commande', 'Valeur', 'Résultat', 'Motif', 'Tag retour', 'Retour', 'Durée (s)'];
        var rows = history.map(function (x) {
            return [date(x.time), x.user || 'anonyme', x.role || '', x.equipment, x.name, x.valueText, x.status, x.reason || '', x.feedbackTag || '', x.feedback === null ? '' : x.feedback, x.duration === null ? '' : x.duration / 1000];
        });
        var csv = [head].concat(rows).map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';'); }).join('\r\n');
        SiteApi.download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), 'commandes-' + SiteApi.siteId + '.csv');
    });

    // ---------------------------------------------------------------- configuration
    function loadConfig() {
        SiteApi.request('GET', '/commands/config').then(function (r) {
            config = r.data.commands;
            document.getElementById('h-command').innerHTML = '<option value="">Toutes les commandes</option>' + config.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('');
            document.getElementById('c-rows').innerHTML = config.map(function (c, i) {
                return '<tr><td><input type="checkbox" data-on="' + i + '"' + (c.enabled ? ' checked' : '') + '></td><td>' + esc(c.equipment) + '</td><td>' + esc(c.name) + '</td>' +
                    '<td>' + esc((TYPES.filter(function (t) { return t[0] === c.type; })[0] || [])[1]) + (c.type === 'setpoint' ? ' <small>' + esc(c.min) + ' à ' + esc(c.max) + ' ' + esc(c.unit) + '</small>' : '') + '</td>' +
                    '<td>' + esc(c.tagName) + (c.feedbackTagName ? '<br><small>retour : ' + esc(c.feedbackTagName) + ' (' + c.timeout + ' s)</small>' : '<br><small>sans retour d’état</small>') + '</td>' +
                    '<td>' + esc(c.minRole) + (c.critical ? ', mot de passe' : c.confirm ? ', confirmation' : '') + '</td>' +
                    '<td>' + c.interlocks.map(function (l) { return esc(l.text) + ' <small>(' + esc(l.tagName) + ' ' + esc(l.op) + ' ' + esc(l.value) + ')</small>'; }).join('<br>') + '</td>' +
                    '<td><button data-edit="' + i + '">Modifier</button> <button data-del="' + i + '">Supprimer</button></td></tr>';
            }).join('') || '<tr><td colspan="8" class="empty">Aucune commande.</td></tr>';
        }).catch(function (err) { status('c-status', err.message, true); });
    }

    function toSave() {
        return config.map(function (c) {
            return { id: c.id, name: c.name, type: c.type, enabled: c.enabled, equipment: c.equipment, tag: c.tag, feedbackTag: c.feedbackTag, timeout: c.timeout, tolerance: c.tolerance,
                min: c.min, max: c.max, unit: c.unit, confirm: c.confirm, critical: c.critical, minRole: c.minRole,
                interlocks: c.interlocks.map(function (l) { return { tag: l.tag, op: l.op, value: l.value, text: l.text, when: l.when }; }) };
        });
    }

    function saveAll(list, text) {
        return SiteApi.request('PUT', '/commands/config', { commands: list }).then(function () {
            status('c-status', text);
            document.getElementById('c-form').innerHTML = '';
            loadConfig();
        });
    }

    function tagOptions(selected, optional) {
        var byDevice = {};
        tags.forEach(function (t) { (byDevice[t.device || 'Sans équipement'] = byDevice[t.device || 'Sans équipement'] || []).push(t); });
        return '<option value="">' + (optional ? '(aucun)' : '(choisir un tag)') + '</option>' + Object.keys(byDevice).map(function (d) {
            return '<optgroup label="' + esc(d) + '">' + byDevice[d].map(function (t) {
                return '<option value="' + esc(t.id) + '"' + (t.id === selected ? ' selected' : '') + '>' + esc(t.name) + '</option>';
            }).join('') + '</optgroup>';
        }).join('');
    }

    function lockRow(l, type) {
        return '<div class="sc-cond">Bloquer si <select class="l-tag">' + tagOptions(l.tag) + '</select><select class="l-op">' + options(OPS, l.op || '=') + '</select>' +
            '<input class="l-value" type="number" step="any" style="width:70px" value="' + esc(l.value === undefined ? 1 : l.value) + '">' +
            ' message <input class="l-text" size="28" value="' + esc(l.text || '') + '" placeholder="Pompe en défaut">' +
            (type === 'setpoint' ? '<input type="hidden" class="l-when" value="all">' : ' pour <select class="l-when">' + options(WHEN[type], l.when || 'on') + '</select>') +
            ' <button class="l-del" title="Retirer">✕</button></div>';
    }

    function editCommand(index) {
        var c = index === null ? { name: '', type: 'onoff', enabled: true, equipment: '', tag: '', feedbackTag: '', timeout: 15, tolerance: 1, min: null, max: null, unit: '',
            confirm: true, critical: false, minRole: 'operateur', interlocks: [] } : config[index];
        var form = document.getElementById('c-form');
        var draw = function (type) {
            form.innerHTML = '<div class="graph-card"><h3>' + (index === null ? 'Nouvelle commande' : 'Modifier « ' + esc(c.name) + ' »') + '</h3>' +
                '<div class="period"><label>Nom <input id="ce-name" size="32" value="' + esc(c.name) + '"></label><label>Équipement <input id="ce-eq" size="18" value="' + esc(c.equipment) + '"></label>' +
                '<label>Type <select id="ce-type">' + options(TYPES, type) + '</select></label></div>' +
                '<div class="period"><label>Tag écrit <select id="ce-tag">' + tagOptions(c.tag) + '</select></label>' +
                '<label>Tag de retour d’état <select id="ce-fb">' + tagOptions(c.feedbackTag, true) + '</select></label>' +
                '<label>Délai du retour <input id="ce-timeout" type="number" min="1" style="width:60px" value="' + esc(c.timeout) + '"> s</label></div>' +
                (type === 'setpoint' ? '<div class="period"><label>Minimum <input id="ce-min" type="number" step="any" style="width:80px" value="' + esc(c.min === null ? '' : c.min) + '"></label>' +
                    '<label>Maximum <input id="ce-max" type="number" step="any" style="width:80px" value="' + esc(c.max === null ? '' : c.max) + '"></label>' +
                    '<label>Unité <input id="ce-unit" size="6" value="' + esc(c.unit) + '"></label>' +
                    '<label>Tolérance du retour <input id="ce-tol" type="number" step="any" style="width:60px" value="' + esc(c.tolerance) + '"></label></div>' : '') +
                '<div class="period"><label>Rôle minimum <select id="ce-role">' + options(ROLES, c.minRole) + '</select></label>' +
                '<label><input type="checkbox" id="ce-confirm"' + (c.confirm ? ' checked' : '') + '> sensible : confirmation avant l’envoi</label>' +
                '<label><input type="checkbox" id="ce-critical"' + (c.critical ? ' checked' : '') + '> critique : mot de passe redemandé</label></div>' +
                '<div><b>Verrouillages</b> (la commande est refusée quand la condition est vraie, ou quand la valeur du tag est inconnue)</div>' +
                '<div id="ce-locks">' + c.interlocks.map(function (l) { return lockRow(l, type); }).join('') + '</div>' +
                '<div class="period"><button id="ce-addlock">+ Verrouillage</button></div>' +
                '<div class="period"><button id="ce-save" class="primary">Enregistrer</button><button id="ce-cancel">Annuler</button><span id="ce-status" class="status"></span></div></div>';
            var locks = document.getElementById('ce-locks');
            document.getElementById('ce-type').addEventListener('change', function () { c = read(); draw(this.value); });
            document.getElementById('ce-addlock').addEventListener('click', function () { locks.insertAdjacentHTML('beforeend', lockRow({}, type)); });
            locks.addEventListener('click', function (e) { if (e.target.className === 'l-del') { e.target.parentNode.remove(); } });
            document.getElementById('ce-cancel').addEventListener('click', function () { form.innerHTML = ''; });
            document.getElementById('ce-save').addEventListener('click', function () {
                var cmd = read();
                if (!cmd.name) { status('ce-status', 'Écrire le nom de la commande.', true); return; }
                var list = toSave();
                if (index === null) { list.push(cmd); } else { list[index] = cmd; }
                saveAll(list, 'Commande « ' + cmd.name + ' » enregistrée.').catch(function (err) { status('ce-status', err.message, true); });
            });
            form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
        var read = function () {
            var v = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
            var type = v('ce-type');
            return {
                id: c.id, enabled: c.enabled, name: v('ce-name').trim(), equipment: v('ce-eq').trim(), type: type, tag: v('ce-tag'), feedbackTag: v('ce-fb'),
                timeout: Number(v('ce-timeout')), min: v('ce-min'), max: v('ce-max'), unit: v('ce-unit'), tolerance: v('ce-tol') === '' ? c.tolerance : Number(v('ce-tol')),
                minRole: v('ce-role'), confirm: document.getElementById('ce-confirm').checked, critical: document.getElementById('ce-critical').checked,
                interlocks: Array.prototype.map.call(document.getElementById('ce-locks').children, function (row) {
                    return { tag: row.querySelector('.l-tag').value, op: row.querySelector('.l-op').value, value: row.querySelector('.l-value').value,
                        text: row.querySelector('.l-text').value, when: row.querySelector('.l-when').value };
                })
            };
        };
        draw(c.type);
    }

    document.getElementById('c-new').addEventListener('click', function () { editCommand(null); });
    document.getElementById('c-preset').addEventListener('click', function () {
        SiteApi.request('POST', '/commands/preset').then(function (r) {
            status('c-status', r.meta.added + ' commande(s) ajoutée(s).');
            loadConfig();
        }).catch(function (err) { status('c-status', err.message, true); });
    });
    document.getElementById('c-rows').addEventListener('click', function (e) {
        var edit = e.target.getAttribute('data-edit'), del = e.target.getAttribute('data-del'), on = e.target.getAttribute('data-on');
        var list = toSave();
        if (edit !== null) { editCommand(Number(edit)); }
        if (del !== null && confirm('Supprimer la commande « ' + list[Number(del)].name + ' » ?')) {
            var name = list[Number(del)].name;
            list.splice(Number(del), 1);
            saveAll(list, 'Commande « ' + name + ' » supprimée.').catch(function (err) { status('c-status', err.message, true); });
        }
        if (on !== null) {
            list[Number(on)].enabled = e.target.checked;
            saveAll(list, 'Commande « ' + list[Number(on)].name + ' » ' + (e.target.checked ? 'activée.' : 'désactivée.')).catch(function (err) { status('c-status', err.message, true); loadConfig(); });
        }
    });

    // ---------------------------------------------------------------- tabs
    function showTab(name) {
        tab = name;
        document.querySelectorAll('.tabs button').forEach(function (b) { b.className = b.getAttribute('data-tab') === name ? 'on' : ''; });
        ['control', 'history', 'config'].forEach(function (t) { document.getElementById('tab-' + t).style.display = t === name ? '' : 'none'; });
        clearInterval(timer);
        if (name === 'control') {
            loadCommands();
            timer = setInterval(function () { if (!document.hidden) { loadCommands(); } }, 2000);
        }
        if (name === 'history') { loadHistory(); }
        if (name === 'config') { loadConfig(); }
    }
    document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); }); });
    var HASH_TAB = { '#historique': 'history', '#configuration': 'config' };
    window.addEventListener('hashchange', function () { showTab(HASH_TAB[location.hash] || 'control'); });

    SiteApi.info().then(function (info) {
        tags = info.tags;
        loadConfig();
        showTab(HASH_TAB[location.hash] || 'control');
    }).catch(function (err) { status('k-status', err.message, true); });
})();
