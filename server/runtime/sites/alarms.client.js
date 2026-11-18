/**
 * custom-SCADA: alarmes.js, page Alarmes of a site (alarmes.html): active alarms (refreshed every 5 s, acknowledgement),
 * history of the alarms, filters (equipment, tag, priority, text, period) and thresholds of the alarms of the tags.
 * Uses the API v1 of the server with site-api.js; the page has <div id="alarms-app">.
 */
(function () {
    'use strict';

    var app = document.getElementById('alarms-app');
    var LEVELS = [['highhigh', 'Critique'], ['high', 'Haute'], ['low', 'Basse'], ['info', 'Information']];
    var LEVEL_NAME = { highhigh: 'Critique', high: 'Haute', low: 'Basse', info: 'Information' };
    var tags = [], devices = [], tab = 'active', timer = null, history = [], historyToken = null;

    function esc(t) {
        return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
        });
    }

    function date(ms) {
        return ms ? SiteApi.formatDate(ms, true) : '';
    }

    function duration(a) {
        if (!a.ontime) { return ''; }
        var s = Math.round(((a.offtime || Date.now()) - a.ontime) / 1000);
        if (s < 60) { return s + ' s'; }
        if (s < 3600) { return Math.floor(s / 60) + ' min ' + (s % 60) + ' s'; }
        return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
    }

    function status(id, text, error) {
        var el = document.getElementById(id);
        el.textContent = text;
        el.className = 'status' + (error ? ' error' : '');
    }

    /** value of the alarm: numbers with 3 decimals at most */
    function value(v) {
        var n = Number(v);
        return v === null || v === undefined || v === '' ? '' : isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(v);
    }

    function srcBadge(a) {
        return a.source && a.source !== 'alarme' ? '<span class="src">' + esc(a.sourceText) + '</span>' : '';
    }

    function badge(type) {
        return '<span class="lvl lvl-' + esc(type) + '">' + esc(LEVEL_NAME[type] || type) + '</span>';
    }

    app.innerHTML =
        '<div class="alarm-counts" id="a-counts"></div>' +
        '<div class="tabs"><button data-tab="active" class="on">Alarmes actives</button><button data-tab="history">Historique</button>' +
        '<button data-tab="config">Seuils d’alarme</button><button data-tab="scenarios">Scénarios</button><button data-tab="stats">Statistiques</button></div>' +
        '<div class="period" id="a-filters">' +
        '  <select id="f-device"><option value="">Tous les équipements</option></select>' +
        '  <select id="f-tag"><option value="">Tous les tags</option></select>' +
        LEVELS.map(function (l) { return '<label><input type="checkbox" class="f-level" value="' + l[0] + '" checked> ' + l[1] + '</label>'; }).join('') +
        '  <select id="f-source"><option value="">Toutes les sources</option><option value="alarme">Seuils</option><option value="scenario">Scénarios</option><option value="communication">Communication</option></select>' +
        '  <input id="f-text" size="18" placeholder="Texte du message">' +
        '  <span id="f-period" style="display:none"><label>Du <input type="datetime-local" id="f-from"></label> <label>Au <input type="datetime-local" id="f-to"></label>' +
        '  <button data-hours="24">24 h</button><button data-hours="168">7 j</button><button data-hours="720">30 j</button> <button id="f-show" class="primary">Afficher</button></span>' +
        '</div>' +
        '<div id="tab-active"><div class="period"><button id="ack-all">Tout acquitter</button><span id="a-status" class="status"></span></div>' +
        '<div class="history"><table><thead><tr><th>Priorité</th><th>Début</th><th>Tag</th><th>Équipement</th><th>Message</th><th>Valeur</th><th>État</th><th>Durée</th><th>Acquittement</th><th></th></tr></thead>' +
        '<tbody id="a-rows"></tbody></table></div></div>' +
        '<div id="tab-history" style="display:none"><div class="period"><button id="h-csv">Exporter en CSV</button><span id="h-status" class="status"></span></div>' +
        '<div class="history"><table><thead><tr><th>Priorité</th><th>Début</th><th>Fin</th><th>Durée</th><th>Acquittement</th><th>Tag</th><th>Équipement</th><th>Message</th><th>Valeur</th><th>État</th></tr></thead>' +
        '<tbody id="h-rows"></tbody></table></div></div>' +
        '<div id="tab-config" style="display:none"><p class="info">Une alarme surveille un tag : pour chaque niveau de priorité, l’alarme s’active quand la valeur dépasse le seuil ' +
        '(au-dessus, en dessous ou entre deux valeurs) pendant le délai choisi. Les alarmes critiques sont mises en évidence dans la liste des alarmes actives.</p>' +
        '<div class="period"><button id="c-new" class="primary">+ Nouvelle alarme</button><span id="c-status" class="status"></span></div>' +
        '<div id="c-form"></div>' +
        '<table><thead><tr><th>Nom</th><th>Tag</th><th>Équipement</th><th>Seuils</th><th></th></tr></thead><tbody id="c-rows"></tbody></table></div>' +
        '<div id="tab-scenarios" style="display:none"><p class="info">Un scénario combine plusieurs conditions sur des tags (toutes vraies : ET, ou une seule : OU). ' +
        'L’événement s’active quand le scénario reste vrai pendant le délai choisi, par exemple « pompe en marche et débit nul pendant 10 s ». ' +
        'Les alarmes de communication s’activent seules quand un équipement ne communique plus.</p>' +
        '<div class="period"><label><input type="checkbox" id="s-comm"> Alarmes de communication (critiques)</label> <label>après <input type="number" id="s-commdelay" min="0" max="3600" style="width:70px"> s</label>' +
        ' <button id="s-commsave">Enregistrer</button></div>' +
        '<div class="period"><button id="s-new" class="primary">+ Nouveau scénario</button><button id="s-preset">Ajouter les scénarios type « station de pompage »</button><span id="s-status" class="status"></span></div>' +
        '<div id="s-form"></div>' +
        '<table><thead><tr><th>Actif</th><th>Nom</th><th>Priorité</th><th>Conditions</th><th>Délai</th><th>Message</th><th></th></tr></thead><tbody id="s-rows"></tbody></table></div>' +
        '<div id="tab-stats" style="display:none"><div class="period"><span id="st-status" class="status"></span></div>' +
        '<div class="diag-cards" id="st-cards"></div>' +
        '<div class="stats-grid" style="display:flex;flex-wrap:wrap;gap:30px"><div><h3>Par équipement</h3><div id="st-devices"></div></div><div><h3>Par jour</h3><div id="st-days"></div></div></div>' +
        '<h3>Alarmes les plus fréquentes</h3><div class="history"><table><thead><tr><th>Priorité</th><th>Message</th><th>Source</th><th>Tag</th><th>Équipement</th><th>Nombre</th><th>Durée totale</th><th>Acquittées</th><th>Dernière</th></tr></thead>' +
        '<tbody id="st-rows"></tbody></table></div></div>';

    // ---------------------------------------------------------------- filters
    function filters() {
        var levels = Array.prototype.filter.call(document.querySelectorAll('.f-level'), function (c) { return c.checked; }).map(function (c) { return c.value; });
        return {
            device: document.getElementById('f-device').value,
            tag: document.getElementById('f-tag').value,
            type: levels.length === LEVELS.length ? '' : (levels.join(',') || 'none'),
            text: document.getElementById('f-text').value.trim(),
            source: document.getElementById('f-source').value
        };
    }

    function fillFilters() {
        document.getElementById('f-device').innerHTML = '<option value="">Tous les équipements</option>' + devices.map(function (d) {
            return '<option>' + esc(d.name) + '</option>';
        }).join('');
        drawTagFilter();
    }

    function drawTagFilter() {
        var device = document.getElementById('f-device').value;
        var current = document.getElementById('f-tag').value;
        document.getElementById('f-tag').innerHTML = '<option value="">Tous les tags</option>' + tags.filter(function (t) { return !device || t.device === device; }).map(function (t) {
            return '<option' + (t.name === current ? ' selected' : '') + '>' + esc(t.name) + '</option>';
        }).join('');
    }

    function refreshTab() {
        if (tab === 'active') { loadActive(); }
        if (tab === 'history') { loadHistory(); }
        if (tab === 'stats') { loadStats(); }
    }

    document.getElementById('f-device').addEventListener('change', function () { drawTagFilter(); refreshTab(); });
    document.getElementById('f-tag').addEventListener('change', refreshTab);
    document.getElementById('f-source').addEventListener('change', refreshTab);
    document.querySelectorAll('.f-level').forEach(function (c) { c.addEventListener('change', refreshTab); });
    var textTimer = null;
    document.getElementById('f-text').addEventListener('input', function () { clearTimeout(textTimer); textTimer = setTimeout(refreshTab, 400); });

    // ---------------------------------------------------------------- active alarms
    function drawCounts(counts) {
        document.getElementById('a-counts').innerHTML =
            '<span class="cnt lvl-highhigh' + (counts.highhigh ? ' blink' : '') + '">' + counts.highhigh + ' critique(s)</span>' +
            '<span class="cnt lvl-high">' + counts.high + ' haute(s)</span><span class="cnt lvl-low">' + counts.low + ' basse(s)</span>' +
            '<span class="cnt lvl-info">' + counts.info + ' information(s)</span><span class="cnt toack">' + counts.toack + ' à acquitter</span>';
    }

    function loadActive() {
        var f = filters();
        if (f.type === 'none') { document.getElementById('a-rows').innerHTML = '<tr><td colspan="10" class="empty">Aucune priorité cochée.</td></tr>'; return; }
        SiteApi.request('GET', '/alarms', undefined, f).then(function (r) {
            drawCounts(r.meta.counts);
            document.getElementById('a-rows').innerHTML = r.data.map(function (a) {
                return '<tr class="' + (a.critical ? 'row-critical' : '') + '"><td>' + badge(a.type) + '</td><td>' + date(a.ontime) + '</td><td>' + esc(a.tag) + '</td>' +
                    '<td>' + esc(a.device) + '</td><td>' + esc(a.text) + srcBadge(a) + (a.group ? ' <small>(' + esc(a.group) + ')</small>' : '') + '</td><td>' + esc(value(a.value)) + '</td>' +
                    '<td>' + esc(a.statusText) + '</td><td>' + duration(a) + '</td><td>' + (a.acktime ? date(a.acktime) + (a.userack ? ' (' + esc(a.userack) + ')' : '') : '') + '</td>' +
                    '<td>' + (a.toack ? '<button data-ack="' + esc(a.alarm_id) + '">Acquitter</button>' : '') + '</td></tr>';
            }).join('') || '<tr><td colspan="10" class="empty">Aucune alarme active.</td></tr>';
            status('a-status', r.data.length + ' alarme(s) affichée(s), mise à jour ' + SiteApi.formatDate(r.meta.time, true).slice(11));
        }).catch(function (err) { status('a-status', err.message, true); });
    }

    document.getElementById('a-rows').addEventListener('click', function (e) {
        var id = e.target.getAttribute('data-ack');
        if (!id) { return; }
        SiteApi.request('POST', '/alarms/' + encodeURIComponent(id) + '/ack').then(loadActive).catch(function (err) { status('a-status', err.message, true); });
    });
    document.getElementById('ack-all').addEventListener('click', function () {
        if (!confirm('Acquitter toutes les alarmes ?')) { return; }
        SiteApi.request('POST', '/alarms/ack').then(loadActive).catch(function (err) { status('a-status', err.message, true); });
    });

    // ---------------------------------------------------------------- history
    /** last n hours (until now at each loading), or the dates typed (relativeHours null) */
    var relativeHours = 24;
    function setPeriod(hours) {
        relativeHours = hours;
        var now = Date.now();
        document.getElementById('f-from').value = SiteApi.inputValue(now - hours * 3600000);
        document.getElementById('f-to').value = SiteApi.inputValue(now);
    }
    ['f-from', 'f-to'].forEach(function (id) {
        document.getElementById(id).addEventListener('change', function () { relativeHours = null; });
    });

    function periodOf(f) {
        if (relativeHours) {
            setPeriod(relativeHours);
            f.to = Date.now();
            f.from = f.to - relativeHours * 3600000;
        } else {
            f.from = new Date(document.getElementById('f-from').value).getTime();
            f.to = new Date(document.getElementById('f-to').value).getTime();
        }
        return f;
    }

    function loadHistory() {
        var f = filters();
        if (f.type === 'none') { document.getElementById('h-rows').innerHTML = '<tr><td colspan="10" class="empty">Aucune priorité cochée.</td></tr>'; return; }
        if (relativeHours) {
            // the inputs are rounded to the minute: the exact time is sent
            setPeriod(relativeHours);
            f.to = Date.now();
            f.from = f.to - relativeHours * 3600000;
        } else {
            f.from = new Date(document.getElementById('f-from').value).getTime();
            f.to = new Date(document.getElementById('f-to').value).getTime();
        }
        status('h-status', 'Chargement...');
        var token = historyToken = {};
        SiteApi.request('GET', '/alarms/history', undefined, f).then(function (r) {
            // only the answer of the last request is shown
            if (token !== historyToken) { return; }
            history = r.data;
            document.getElementById('h-rows').innerHTML = history.map(function (a) {
                return '<tr class="' + (a.critical ? 'row-critical' : '') + '"><td>' + badge(a.type) + '</td><td>' + date(a.ontime) + '</td><td>' + date(a.offtime) + '</td>' +
                    '<td>' + duration(a) + '</td><td>' + (a.acktime ? date(a.acktime) + (a.userack ? ' (' + esc(a.userack) + ')' : '') : '') + '</td><td>' + esc(a.tag) + '</td>' +
                    '<td>' + esc(a.device) + '</td><td>' + esc(a.text) + srcBadge(a) + '</td><td>' + esc(value(a.value)) + '</td><td>' + esc(a.statusText) + '</td></tr>';
            }).join('') || '<tr><td colspan="10" class="empty">Aucune alarme sur cette période.</td></tr>';
            var c = r.meta.counts;
            status('h-status', history.length + ' alarme(s) : ' + c.highhigh + ' critique(s), ' + c.high + ' haute(s), ' + c.low + ' basse(s), ' + c.info + ' information(s)');
        }).catch(function (err) { status('h-status', err.message, true); });
    }

    document.querySelectorAll('#f-period [data-hours]').forEach(function (b) {
        b.addEventListener('click', function () { setPeriod(Number(b.getAttribute('data-hours'))); refreshTab(); });
    });
    document.getElementById('f-show').addEventListener('click', refreshTab);
    document.getElementById('h-csv').addEventListener('click', function () {
        var head = ['Priorité', 'Début', 'Fin', 'Durée', 'Acquittement', 'Utilisateur', 'Tag', 'Équipement', 'Message', 'Valeur', 'État'];
        var rows = history.map(function (a) {
            return [LEVEL_NAME[a.type] || a.type, date(a.ontime), date(a.offtime), duration(a), date(a.acktime), a.userack || '', a.tag || '', a.device || '', a.text, value(a.value), a.statusText];
        });
        var csv = [head].concat(rows).map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(';'); }).join('\r\n');
        SiteApi.download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), 'alarmes-' + SiteApi.siteId + '.csv');
    });

    // ---------------------------------------------------------------- thresholds
    var CONDITIONS = [['above', 'au-dessus de (≥)'], ['below', 'en dessous de (≤)'], ['between', 'entre']];
    var ACKMODES = [['ackactive', 'acquittement obligatoire'], ['ackpassive', 'acquittement après la fin'], ['float', 'sans acquittement']];
    var configs = [];

    function levelText(l) {
        if (l.condition === 'above') { return '≥ ' + l.value; }
        if (l.condition === 'below') { return '≤ ' + l.value; }
        return 'entre ' + l.min + ' et ' + l.max;
    }

    function loadConfig() {
        SiteApi.request('GET', '/alarms/config').then(function (r) {
            configs = r.data;
            document.getElementById('c-rows').innerHTML = configs.map(function (c, i) {
                var levels = LEVELS.filter(function (l) { return c.levels[l[0]].enabled; }).map(function (l) {
                    return badge(l[0]) + ' ' + esc(levelText(c.levels[l[0]])) + (c.levels[l[0]].text ? ' : ' + esc(c.levels[l[0]].text) : '');
                }).join('<br>');
                return '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.tag || c.tagId) + '</td><td>' + esc(c.device) + '</td><td>' + levels + '</td>' +
                    '<td style="white-space:nowrap"><button data-edit="' + i + '">Modifier</button> <button data-del="' + i + '">Supprimer</button></td></tr>';
            }).join('') || '<tr><td colspan="5" class="empty">Aucune alarme configurée.</td></tr>';
            status('c-status', configs.length + ' alarme(s) configurée(s)');
        }).catch(function (err) { status('c-status', err.message, true); });
    }

    function options(values, selected) {
        return values.map(function (v) { return '<option value="' + esc(v[0]) + '"' + (v[0] === selected ? ' selected' : '') + '>' + esc(v[1]) + '</option>'; }).join('');
    }

    function editConfig(c) {
        var isNew = !c;
        c = c || { name: '', tag: '', levels: {} };
        var form = document.getElementById('c-form');
        var byDevice = {};
        tags.forEach(function (t) { (byDevice[t.device] = byDevice[t.device] || []).push(t); });
        form.innerHTML = '<div class="graph-card"><h3>' + (isNew ? 'Nouvelle alarme' : 'Modifier l’alarme « ' + esc(c.name) + ' »') + '</h3>' +
            '<div class="period"><label>Nom <input id="e-name" size="24" value="' + esc(c.name) + '"' + (isNew ? '' : ' disabled') + '></label>' +
            '<label>Tag <select id="e-tag"><option value="">(choisir)</option>' + Object.keys(byDevice).map(function (d) {
                return '<optgroup label="' + esc(d) + '">' + byDevice[d].map(function (t) {
                    return '<option value="' + esc(t.name) + '"' + (t.name === c.tag ? ' selected' : '') + '>' + esc(t.name) + (t.description ? ' — ' + esc(t.description) : '') + '</option>';
                }).join('') + '</optgroup>';
            }).join('') + '</select></label><span id="e-value" class="status"></span></div>' +
            '<table><thead><tr><th>Niveau</th><th>Actif</th><th>Condition</th><th>Seuil</th><th>Message</th><th>Groupe</th><th>Délai (s)</th><th>Acquittement</th></tr></thead><tbody>' +
            LEVELS.map(function (l) {
                var v = c.levels[l[0]] || { enabled: false, condition: l[0] === 'low' ? 'below' : 'above', delay: 1, ackmode: 'ackactive' };
                var k = function (f) { return 'data-l="' + l[0] + '" data-f="' + f + '"'; };
                return '<tr><td>' + badge(l[0]) + '</td><td><input type="checkbox" ' + k('enabled') + (v.enabled ? ' checked' : '') + '></td>' +
                    '<td><select ' + k('condition') + '>' + options(CONDITIONS, v.condition) + '</select></td>' +
                    '<td><input type="number" step="any" style="width:80px" ' + k('value') + ' value="' + esc(v.value === null || v.value === undefined ? '' : v.value) + '">' +
                    '<span data-l="' + l[0] + '" data-between> <input type="number" step="any" style="width:70px" ' + k('min') + ' value="' + esc(v.min === null || v.min === undefined ? '' : v.min) + '">' +
                    ' et <input type="number" step="any" style="width:70px" ' + k('max') + ' value="' + esc(v.max === null || v.max === undefined ? '' : v.max) + '"></span></td>' +
                    '<td><input size="22" ' + k('text') + ' value="' + esc(v.text || '') + '" placeholder="ex. Niveau très haut"></td>' +
                    '<td><input size="10" ' + k('group') + ' value="' + esc(v.group || '') + '"></td>' +
                    '<td><input type="number" min="0" style="width:60px" ' + k('delay') + ' value="' + esc(v.delay === undefined ? 1 : v.delay) + '"></td>' +
                    '<td><select ' + k('ackmode') + '>' + options(ACKMODES, v.ackmode || 'ackactive') + '</select></td></tr>';
            }).join('') + '</tbody></table>' +
            '<div class="period"><button id="e-save" class="primary">Enregistrer</button><button id="e-cancel">Annuler</button><span id="e-status" class="status"></span></div></div>';
        var showCondition = function () {
            LEVELS.forEach(function (l) {
                var between = form.querySelector('[data-l="' + l[0] + '"][data-f="condition"]').value === 'between';
                form.querySelector('[data-l="' + l[0] + '"][data-f="value"]').style.display = between ? 'none' : '';
                form.querySelector('[data-l="' + l[0] + '"][data-between]').style.display = between ? '' : 'none';
            });
        };
        var showValue = function () {
            var name = document.getElementById('e-tag').value;
            if (!name) { document.getElementById('e-value').textContent = ''; return; }
            SiteApi.values([name]).then(function (r) {
                var v = r.values[0];
                document.getElementById('e-value').textContent = 'valeur actuelle : ' + (v && v.value !== null ? v.value : '—');
            }).catch(function () { /* no value */ });
        };
        form.addEventListener('change', function (e) {
            if (e.target.getAttribute('data-f') === 'condition') { showCondition(); }
        });
        document.getElementById('e-tag').addEventListener('change', function () {
            if (isNew && !document.getElementById('e-name').value) { document.getElementById('e-name').value = document.getElementById('e-tag').value; }
            showValue();
        });
        document.getElementById('e-cancel').addEventListener('click', function () { form.innerHTML = ''; });
        document.getElementById('e-save').addEventListener('click', function () {
            var name = document.getElementById('e-name').value.trim();
            var levels = {};
            LEVELS.forEach(function (l) {
                var get = function (f) { var el = form.querySelector('[data-l="' + l[0] + '"][data-f="' + f + '"]'); return el.type === 'checkbox' ? el.checked : el.value; };
                levels[l[0]] = {
                    enabled: get('enabled'), condition: get('condition'), value: get('value'), min: get('min'), max: get('max'),
                    text: get('text'), group: get('group'), delay: Number(get('delay')), ackmode: get('ackmode')
                };
            });
            if (!name) { status('e-status', 'Écrire le nom de l’alarme.', true); return; }
            SiteApi.request('PUT', '/alarms/config/' + encodeURIComponent(name), { tag: document.getElementById('e-tag').value, levels: levels }).then(function () {
                form.innerHTML = '';
                status('c-status', 'Alarme « ' + name + ' » enregistrée.');
                loadConfig();
            }).catch(function (err) { status('e-status', err.message, true); });
        });
        showCondition();
        showValue();
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    document.getElementById('c-new').addEventListener('click', function () { editConfig(null); });
    document.getElementById('c-rows').addEventListener('click', function (e) {
        var edit = e.target.getAttribute('data-edit'), del = e.target.getAttribute('data-del');
        if (edit !== null) { editConfig(configs[Number(edit)]); }
        if (del !== null) {
            var c = configs[Number(del)];
            if (!confirm('Supprimer l’alarme « ' + c.name + ' » ?')) { return; }
            SiteApi.request('DELETE', '/alarms/config/' + encodeURIComponent(c.name)).then(loadConfig).catch(function (err) { status('c-status', err.message, true); });
        }
    });

    // ---------------------------------------------------------------- scenarios
    var OPS = [['>', '>'], ['>=', '≥'], ['<', '<'], ['<=', '≤'], ['=', '='], ['!=', '≠']];
    var scenarioConfig = { commAlarms: true, commDelay: 10, rules: [] };

    function conditionText(c) {
        var op = OPS.filter(function (o) { return o[0] === c.op; })[0];
        return esc(c.tagName || c.tag) + ' ' + esc(op ? op[1] : c.op) + ' ' + esc(c.value);
    }

    function loadScenarios() {
        SiteApi.request('GET', '/alarms/scenarios').then(function (r) {
            scenarioConfig = r.data;
            document.getElementById('s-comm').checked = !!r.data.commAlarms;
            document.getElementById('s-commdelay').value = r.data.commDelay;
            document.getElementById('s-rows').innerHTML = r.data.rules.map(function (rule, i) {
                return '<tr><td><input type="checkbox" data-on="' + i + '"' + (rule.enabled ? ' checked' : '') + '></td><td>' + esc(rule.name) + '</td><td>' + badge(rule.level) + '</td>' +
                    '<td>' + rule.conditions.map(conditionText).join(rule.logic === 'or' ? ' <b>OU</b> ' : ' <b>ET</b> ') + '</td><td>' + esc(rule.delay) + ' s</td>' +
                    '<td>' + esc(rule.text) + '</td><td><button data-sedit="' + i + '">Modifier</button> <button data-sdel="' + i + '">Supprimer</button></td></tr>';
            }).join('') || '<tr><td colspan="7" class="empty">Aucun scénario.</td></tr>';
        }).catch(function (err) { status('s-status', err.message, true); });
    }

    /** the rules as the API expects them (tag ids) */
    function rulesToSave() {
        return scenarioConfig.rules.map(function (r) {
            return { id: r.id, name: r.name, level: r.level, logic: r.logic, delay: r.delay, text: r.text, group: r.group, ackmode: r.ackmode, enabled: r.enabled,
                conditions: r.conditions.map(function (c) { return { tag: c.tag, op: c.op, value: c.value }; }) };
        });
    }

    function saveRules(rules, message) {
        return SiteApi.request('PUT', '/alarms/scenarios', { rules: rules }).then(function () {
            status('s-status', message);
            document.getElementById('s-form').innerHTML = '';
            loadScenarios();
        });
    }

    function tagOptions(selected) {
        var byDevice = {};
        tags.forEach(function (t) { (byDevice[t.device || 'Sans équipement'] = byDevice[t.device || 'Sans équipement'] || []).push(t); });
        return '<option value="">(choisir un tag)</option>' + Object.keys(byDevice).map(function (d) {
            return '<optgroup label="' + esc(d) + '">' + byDevice[d].map(function (t) {
                return '<option value="' + esc(t.id) + '"' + (t.id === selected ? ' selected' : '') + '>' + esc(t.name) + '</option>';
            }).join('') + '</optgroup>';
        }).join('');
    }

    function conditionRow(c) {
        return '<div class="sc-cond"><select class="c-tag">' + tagOptions(c.tag) + '</select><select class="c-op">' + options(OPS, c.op || '>') + '</select>' +
            '<input class="c-value" type="number" step="any" style="width:90px" value="' + esc(c.value === undefined ? '' : c.value) + '"> <button class="c-del" title="Retirer la condition">✕</button></div>';
    }

    function editScenario(index) {
        var r = index === null ? { name: '', level: 'high', logic: 'and', delay: 5, text: '', group: '', ackmode: 'ackactive', enabled: true, conditions: [{}] } : scenarioConfig.rules[index];
        var form = document.getElementById('s-form');
        form.innerHTML = '<div class="graph-card"><h3>' + (index === null ? 'Nouveau scénario' : 'Modifier « ' + esc(r.name) + ' »') + '</h3>' +
            '<div class="period"><label>Nom <input id="se-name" size="30" value="' + esc(r.name) + '"></label>' +
            '<label>Priorité <select id="se-level">' + options(LEVELS, r.level) + '</select></label>' +
            '<label>Délai <input id="se-delay" type="number" min="0" style="width:70px" value="' + esc(r.delay) + '"> s</label>' +
            '<label>Acquittement <select id="se-ack">' + options([['ackactive', 'obligatoire'], ['float', 'sans acquittement']], r.ackmode) + '</select></label></div>' +
            '<div class="period"><label>Message <input id="se-text" size="50" value="' + esc(r.text) + '"></label><label>Groupe <input id="se-group" size="15" value="' + esc(r.group) + '"></label></div>' +
            '<div class="period"><label>Conditions <select id="se-logic">' + options([['and', 'toutes vraies (ET)'], ['or', 'une seule vraie (OU)']], r.logic) + '</select></label></div>' +
            '<div id="se-conds">' + r.conditions.map(conditionRow).join('') + '</div>' +
            '<div class="period"><button id="se-add">+ Condition</button></div>' +
            '<div class="period"><button id="se-save" class="primary">Enregistrer</button><button id="se-cancel">Annuler</button><span id="se-status" class="status"></span></div></div>';
        var conds = document.getElementById('se-conds');
        document.getElementById('se-add').addEventListener('click', function () { conds.insertAdjacentHTML('beforeend', conditionRow({})); });
        conds.addEventListener('click', function (e) {
            if (e.target.className === 'c-del' && conds.children.length > 1) { e.target.parentNode.remove(); }
        });
        document.getElementById('se-cancel').addEventListener('click', function () { form.innerHTML = ''; });
        document.getElementById('se-save').addEventListener('click', function () {
            var rule = {
                id: r.id, enabled: r.enabled, name: document.getElementById('se-name').value.trim(), level: document.getElementById('se-level').value,
                delay: Number(document.getElementById('se-delay').value), ackmode: document.getElementById('se-ack').value,
                text: document.getElementById('se-text').value.trim(), group: document.getElementById('se-group').value.trim(), logic: document.getElementById('se-logic').value,
                conditions: Array.prototype.map.call(conds.children, function (row) {
                    return { tag: row.querySelector('.c-tag').value, op: row.querySelector('.c-op').value, value: row.querySelector('.c-value').value };
                })
            };
            if (!rule.name) { status('se-status', 'Écrire le nom du scénario.', true); return; }
            var rules = rulesToSave();
            if (index === null) { rules.push(rule); } else { rules[index] = rule; }
            saveRules(rules, 'Scénario « ' + rule.name + ' » enregistré.').catch(function (err) { status('se-status', err.message, true); });
        });
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    document.getElementById('s-new').addEventListener('click', function () { editScenario(null); });
    document.getElementById('s-preset').addEventListener('click', function () {
        SiteApi.request('POST', '/alarms/scenarios/preset').then(function (r) {
            status('s-status', (r.meta && r.meta.added !== undefined ? r.meta.added + ' scénario(s) ajouté(s).' : 'Scénarios type ajoutés.'));
            loadScenarios();
        }).catch(function (err) { status('s-status', err.message, true); });
    });
    document.getElementById('s-commsave').addEventListener('click', function () {
        SiteApi.request('PUT', '/alarms/scenarios', { commAlarms: document.getElementById('s-comm').checked, commDelay: Number(document.getElementById('s-commdelay').value) }).then(function () {
            status('s-status', 'Alarmes de communication enregistrées.');
        }).catch(function (err) { status('s-status', err.message, true); });
    });
    document.getElementById('s-rows').addEventListener('click', function (e) {
        var edit = e.target.getAttribute('data-sedit'), del = e.target.getAttribute('data-sdel'), on = e.target.getAttribute('data-on');
        var rules = rulesToSave();
        if (edit !== null) { editScenario(Number(edit)); }
        if (del !== null) {
            if (!confirm('Supprimer le scénario « ' + rules[Number(del)].name + ' » ?')) { return; }
            var name = rules[Number(del)].name;
            rules.splice(Number(del), 1);
            saveRules(rules, 'Scénario « ' + name + ' » supprimé.').catch(function (err) { status('s-status', err.message, true); });
        }
        if (on !== null) {
            rules[Number(on)].enabled = e.target.checked;
            saveRules(rules, 'Scénario « ' + rules[Number(on)].name + ' » ' + (e.target.checked ? 'activé.' : 'désactivé.')).catch(function (err) { status('s-status', err.message, true); });
        }
    });

    // ---------------------------------------------------------------- statistics
    function totalDuration(ms) {
        return duration({ ontime: 1, offtime: 1 + ms });
    }

    function bars(list, key) {
        var max = Math.max.apply(null, list.map(function (x) { return x.count; }).concat([1]));
        return list.map(function (x) {
            return '<div class="hbar"><span>' + esc(x[key]) + '</span><i style="width:' + Math.round(x.count / max * 260) + 'px"></i><b>' + x.count + '</b></div>';
        }).join('') || '<p class="empty">Aucune alarme.</p>';
    }

    var statsToken = null;
    function loadStats() {
        var f = periodOf(filters());
        if (f.type === 'none') { status('st-status', 'Aucune priorité cochée.', true); return; }
        status('st-status', 'Chargement...');
        var token = statsToken = {};
        SiteApi.request('GET', '/alarms/stats', undefined, f).then(function (r) {
            if (token !== statsToken) { return; }
            var d = r.data;
            var card = function (title, v, cls) { return '<div class="card">' + title + '<b class="' + (cls || '') + '">' + v + '</b></div>'; };
            document.getElementById('st-cards').innerHTML = card('Alarmes sur la période', d.total) +
                LEVELS.map(function (l) { return card(l[1], d.byLevel[l[0]] || 0, l[0] === 'highhigh' && d.byLevel.highhigh ? 'bad' : ''); }).join('') +
                Object.keys(d.bySource).map(function (k) { return card('Source : ' + k, d.bySource[k]); }).join('');
            document.getElementById('st-devices').innerHTML = bars(d.byDevice, 'device');
            document.getElementById('st-days').innerHTML = bars(d.byDay.map(function (x) { return { day: x.day.split('-').reverse().join('/'), count: x.count }; }), 'day');
            document.getElementById('st-rows').innerHTML = d.top.map(function (a) {
                return '<tr><td>' + badge(a.type) + '</td><td>' + esc(a.text) + '</td><td>' + esc(a.sourceText) + '</td><td>' + esc(a.tag) + '</td><td>' + esc(a.device) + '</td>' +
                    '<td><b>' + a.count + '</b></td><td>' + totalDuration(a.duration) + '</td><td>' + a.acknowledged + ' / ' + a.count + '</td><td>' + date(a.last) + '</td></tr>';
            }).join('') || '<tr><td colspan="9" class="empty">Aucune alarme sur cette période.</td></tr>';
            status('st-status', d.total + ' alarme(s) du ' + date(f.from) + ' au ' + date(f.to));
        }).catch(function (err) { status('st-status', err.message, true); });
    }

    // ---------------------------------------------------------------- tabs
    function showTab(name) {
        tab = name;
        document.querySelectorAll('.tabs button').forEach(function (b) { b.className = b.getAttribute('data-tab') === name ? 'on' : ''; });
        ['active', 'history', 'config', 'scenarios', 'stats'].forEach(function (t) { document.getElementById('tab-' + t).style.display = t === name ? '' : 'none'; });
        document.getElementById('a-filters').style.display = name === 'config' || name === 'scenarios' ? 'none' : '';
        document.getElementById('f-period').style.display = name === 'history' || name === 'stats' ? '' : 'none';
        clearInterval(timer);
        // the active alarms (and the counts at the top) are refreshed every 5 s in all the tabs
        loadActive();
        timer = setInterval(function () { if (!document.hidden) { loadActive(); } }, 5000);
        if (name === 'history') {
            loadHistory();
        } else if (name === 'config') {
            loadConfig();
        } else if (name === 'scenarios') {
            loadScenarios();
        } else if (name === 'stats') {
            loadStats();
        }
    }
    document.querySelectorAll('.tabs button').forEach(function (b) {
        b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
    });

    var HASH_TAB = { '#historique': 'history', '#seuils': 'config', '#scenarios': 'scenarios', '#statistiques': 'stats' };
    window.addEventListener('hashchange', function () { showTab(HASH_TAB[location.hash] || 'active'); });

    setPeriod(24);
    SiteApi.info().then(function (info) {
        tags = info.tags;
        devices = info.devices || [];
        fillFilters();
        showTab(location.hash === '#historique' ? 'history' : location.hash === '#seuils' ? 'config' : location.hash === '#scenarios' ? 'scenarios' : location.hash === '#statistiques' ? 'stats' : 'active');
    }).catch(function (err) { status('a-status', err.message, true); });
})();
