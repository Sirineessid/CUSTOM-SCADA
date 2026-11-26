/**
 * custom-SCADA: simulateur.js, page Simulateur of a site (simulateur.html): integrated simulator of equipments
 * (start / stop, virtual equipments, live values, commands, faults, loss of communication, test alarms,
 * recording in PostgreSQL). Refreshed every 2 s. Uses the API v1 with site-api.js; the page has <div id="simulator-app">.
 */
(function () {
    'use strict';

    var app = document.getElementById('simulator-app');
    var types = {}, equipments = [], status = null, editing = null, durations = {};

    function esc(t) {
        return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c];
        });
    }

    function message(id, text, error) {
        var el = document.getElementById(id);
        el.textContent = text;
        el.className = 'status' + (error ? ' error' : '');
    }

    function call(method, path, body, msgId) {
        return SiteApi.request(method, path, body).catch(function (err) {
            message(msgId || 's-status', err.message, true);
            throw err;
        });
    }

    function value(v, unit) {
        if (v === true) { return '<span class="st st-ok">1</span>'; }
        if (v === false) { return '<span class="st st-off">0</span>'; }
        var n = Number(v);
        return isFinite(n) ? (Math.round(n * 1000) / 1000) + (unit ? ' ' + esc(unit) : '') : esc(v);
    }

    app.innerHTML =
        '<section><h2>Simulation</h2>' +
        '<div class="diag-cards" id="s-cards"></div>' +
        '<div class="period"><button id="s-start" class="primary">▶ Démarrer la simulation</button><button id="s-stop">■ Arrêter</button>' +
        '<label>Perte de communication <select id="s-loss-time"><option value="30">30 s</option><option value="60">1 min</option><option value="300">5 min</option></select></label>' +
        '<button id="s-loss">Simuler la perte</button><button id="s-loss-end">Rétablir</button>' +
        '<button id="s-alarms" title="Alarmes sur les niveaux, défauts et mesures hors plage des équipements simulés">Créer les alarmes de test</button>' +
        '<span id="s-status" class="status"></span></div>' +
        '<p class="info">Le simulateur est un serveur OPC UA intégré au site : FUXA le lit avec la connexion « Simulateur » (tags sim_...), comme un automate réel. ' +
        'Les connexions réelles du site ne sont pas modifiées (mode simulation indépendant). Une pompe en mode automatique démarre sous son niveau de marche et s’arrête au-dessus de son niveau d’arrêt.</p></section>' +
        '<section><h2>Équipements simulés</h2>' +
        '<div class="period"><button id="e-new" class="primary">+ Nouvel équipement</button><button id="e-preset">Station de pompage type</button><span id="e-status" class="status"></span></div>' +
        '<div id="e-form"></div><div id="e-list"></div></section>' +
        '<section><h2>Enregistrement dans PostgreSQL</h2>' +
        '<p class="info">Pendant la simulation, les valeurs de tous les équipements simulés sont aussi écrites dans une table PostgreSQL (créée si elle n’existe pas) : time, site, equipement, type, variable, valeur.</p>' +
        '<div class="period"><label><input type="checkbox" id="pg-enabled"> Enregistrer</label>' +
        '<label>Serveur <input id="pg-host" size="14" placeholder="localhost"></label><label>Port <input id="pg-port" size="5"></label>' +
        '<label>Base <input id="pg-database" size="12"></label><label>Utilisateur <input id="pg-user" size="10"></label>' +
        '<label>Mot de passe <input id="pg-password" type="password" size="10" placeholder="inchangé"></label>' +
        '<label>Table <input id="pg-table" size="18"></label><label>Toutes les <input id="pg-interval" size="3"> s</label></div>' +
        '<div class="period"><button id="pg-test">Tester la connexion</button><button id="pg-save" class="primary">Enregistrer la configuration</button><span id="pg-status" class="status"></span></div></section>';

    // ---------------------------------------------------------------- state
    function drawCards() {
        var s = status;
        var loss = s.communicationLoss;
        document.getElementById('s-cards').innerHTML =
            '<div class="card">Simulation<b>' + (s.running ? '<span class="st st-ok">en marche</span>' : '<span class="st st-off">arrêtée</span>') + '</b></div>' +
            '<div class="card">Serveur OPC UA<b>' + (loss ? '<span class="st st-error">perte de communication</span>' : s.serverRunning ? '<span class="st st-ok">disponible</span>' : '<span class="st st-off">arrêté</span>') +
            '</b><small>' + esc(s.endpoint) + (loss ? ' — rétabli dans ' + loss.remaining + ' s' : '') + '</small></div>' +
            '<div class="card">Équipements<b>' + s.equipments.length + '</b><small>connexion « ' + esc(s.device.name) + ' »</small></div>' +
            '<div class="card">Défauts actifs<b' + (s.equipments.some(function (e) { return e.faults.length; }) ? ' class="bad"' : '') + '>' +
            s.equipments.reduce(function (n, e) { return n + e.faults.length; }, 0) + '</b></div>' +
            '<div class="card">PostgreSQL<b>' + (s.postgres.recording ? '<span class="st st-ok">enregistrement</span>' : s.postgres.enabled ? '<span class="st st-warning">en attente</span>' : '<span class="st st-off">non</span>') +
            '</b><small>' + (s.postgres.lastError ? 'erreur : ' + esc(s.postgres.lastError.message) : s.postgres.rows ? s.postgres.rows + ' valeurs écrites' : '') + '</small></div>';
        document.getElementById('s-start').disabled = s.running;
        document.getElementById('s-stop').disabled = !s.running;
        document.getElementById('s-loss').disabled = !s.running || !!loss;
        document.getElementById('s-loss-end').disabled = !loss;
    }

    function drawEquipments() {
        var list = document.getElementById('e-list');
        if (!status.equipments.length) {
            list.innerHTML = '<p class="empty">Aucun équipement simulé : « Station de pompage type » crée 2 pompes, un réservoir, une vanne et un capteur de pression.</p>';
            return;
        }
        list.innerHTML = status.equipments.map(function (e, i) {
            var type = types[e.type];
            var vars = type.vars.map(function (v) {
                var current = e.values[v.name];
                var control = '';
                if (v.write && v.type === 'Boolean') {
                    control = ' <button data-write="' + i + '" data-var="' + esc(v.name) + '" data-value="' + (current ? 0 : 1) + '">' + (current ? 'Mettre à 0' : 'Mettre à 1') + '</button>';
                } else if (v.write) {
                    control = ' <input type="number" style="width:60px" data-set="' + i + '" data-var="' + esc(v.name) + '" value="' + esc(Math.round(current)) + '"> <button data-apply="' + i + '" data-var="' + esc(v.name) + '">OK</button>';
                }
                return '<tr><td>' + esc(v.name) + '</td><td>' + value(current, v.unit) + control + '</td><td><small>' + esc(v.text) + '</small></td><td><small>sim_' + esc((e.id + '_' + v.name).toLowerCase()) + '</small></td></tr>';
            }).join('');
            var faults = Object.keys(type.faults).map(function (f) {
                var active = e.faults.filter(function (x) { return x.fault === f; })[0];
                return active ? '<button class="fault-on" data-clear="' + i + '" data-fault="' + f + '">✕ ' + esc(type.faults[f]) + (active.until ? ' (' + Math.max(0, Math.round((active.until - Date.now()) / 1000)) + ' s)' : '') + '</button>'
                    : '<button data-fault-set="' + i + '" data-fault="' + f + '">' + esc(type.faults[f]) + '</button>';
            }).join(' ');
            return '<div class="graph-card' + (e.faults.length ? ' card-fault' : '') + '"><div class="graph-head"><h3>' + esc(e.id) + ' — ' + esc(e.name) + '</h3><span class="status">' + esc(e.typeText) +
                (e.params.reservoir ? ', vers ' + esc(e.params.reservoir) : '') + '</span><span style="flex:1"></span>' +
                '<button data-edit="' + i + '">Modifier</button><button data-remove="' + i + '">Supprimer</button></div>' +
                '<table><thead><tr><th>Variable</th><th>Valeur</th><th>Description</th><th>Tag FUXA</th></tr></thead><tbody>' + vars + '</tbody></table>' +
                '<div class="period"><b>Défauts :</b> ' + faults + ' <label>durée <select data-duration="' + i + '">' +
                [['0', 'jusqu’à suppression'], ['30', '30 s'], ['120', '2 min'], ['600', '10 min']].map(function (o) {
                    return '<option value="' + o[0] + '"' + (String(durations[e.id] || '0') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
                }).join('') + '</select></label></div></div>';
        }).join('');
    }

    function load() {
        return SiteApi.request('GET', '/simulator').then(function (r) {
            status = r.data.status;
            types = r.data.types;
            equipments = r.data.config.equipments;
            drawCards();
            if (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('#e-list')) {
                drawEquipments();
            }
            return r.data;
        });
    }

    // ---------------------------------------------------------------- actions
    document.getElementById('s-start').addEventListener('click', function () {
        message('s-status', 'Démarrage...');
        call('POST', '/simulator/start').then(function () { message('s-status', 'Simulation démarrée.'); load(); });
    });
    document.getElementById('s-stop').addEventListener('click', function () {
        call('POST', '/simulator/stop').then(function () { message('s-status', 'Simulation arrêtée.'); load(); });
    });
    document.getElementById('s-loss').addEventListener('click', function () {
        call('POST', '/simulator/communication-loss', { duration: Number(document.getElementById('s-loss-time').value) }).then(function (r) {
            message('s-status', 'Perte de communication pendant ' + r.data.duration + ' s : voir la page Diagnostic.');
            load();
        });
    });
    document.getElementById('s-loss-end').addEventListener('click', function () {
        call('DELETE', '/simulator/communication-loss').then(function () { message('s-status', 'Communication rétablie.'); load(); });
    });
    document.getElementById('s-alarms').addEventListener('click', function () {
        call('POST', '/simulator/alarms').then(function (r) { message('s-status', r.data.length + ' alarme(s) créée(s) : ' + r.data.join(', ') + ' (page Alarmes).'); });
    });
    document.getElementById('e-preset').addEventListener('click', function () {
        var replace = equipments.length ? confirm('Remplacer les équipements simulés par la station de pompage type ?') : true;
        if (!replace) { return; }
        call('POST', '/simulator/preset' + (equipments.length ? '?replace=true' : ''), undefined, 'e-status').then(function () {
            message('e-status', 'Station de pompage type créée (tags sim_...).');
            load();
        });
    });

    document.getElementById('e-list').addEventListener('change', function (e) {
        var i = e.target.getAttribute('data-duration');
        if (i !== null) { durations[status.equipments[i].id] = e.target.value; }
    });

    document.getElementById('e-list').addEventListener('click', function (e) {
        var t = e.target, i;
        if ((i = t.getAttribute('data-write')) !== null) {
            call('POST', '/simulator/write', { equipment: status.equipments[i].id, variable: t.getAttribute('data-var'), value: Number(t.getAttribute('data-value')) }).then(load);
        } else if ((i = t.getAttribute('data-apply')) !== null) {
            var input = document.querySelector('[data-set="' + i + '"][data-var="' + t.getAttribute('data-var') + '"]');
            call('POST', '/simulator/write', { equipment: status.equipments[i].id, variable: t.getAttribute('data-var'), value: Number(input.value) }).then(function () { input.blur(); load(); });
        } else if ((i = t.getAttribute('data-fault-set')) !== null) {
            var duration = Number(document.querySelector('[data-duration="' + i + '"]').value);
            call('POST', '/simulator/faults', { equipment: status.equipments[i].id, fault: t.getAttribute('data-fault'), duration: duration }).then(load);
        } else if ((i = t.getAttribute('data-clear')) !== null) {
            call('DELETE', '/simulator/faults/' + encodeURIComponent(status.equipments[i].id) + '/' + encodeURIComponent(t.getAttribute('data-fault'))).then(load);
        } else if ((i = t.getAttribute('data-edit')) !== null) {
            edit(Number(i));
        } else if ((i = t.getAttribute('data-remove')) !== null) {
            var eq = equipments[Number(i)];
            if (!confirm('Supprimer l’équipement simulé « ' + eq.name + ' » et ses tags ?')) { return; }
            saveEquipments(equipments.filter(function (x, k) { return k !== Number(i); }), 'Équipement supprimé.');
        }
    });

    function saveEquipments(list, done) {
        return call('PUT', '/simulator/equipments', { equipments: list }, 'e-status').then(function () {
            message('e-status', done);
            document.getElementById('e-form').innerHTML = '';
            editing = null;
            return load();
        });
    }

    /** form of an equipment: type, id, name and the parameters of the type */
    function edit(index) {
        editing = index;
        var eq = index === null ? { id: '', type: 'pompe', name: '', params: {} } : JSON.parse(JSON.stringify(equipments[index]));
        var form = document.getElementById('e-form');
        var tanks = equipments.filter(function (x) { return x.type === 'reservoir'; });
        function draw() {
            var type = types[eq.type];
            form.innerHTML = '<div class="graph-card"><h3>' + (index === null ? 'Nouvel équipement' : 'Modifier ' + esc(eq.id)) + '</h3><div class="period">' +
                '<label>Type <select id="f-type"' + (index === null ? '' : ' disabled') + '>' + Object.keys(types).map(function (k) {
                    return '<option value="' + k + '"' + (k === eq.type ? ' selected' : '') + '>' + esc(types[k].label) + '</option>';
                }).join('') + '</select></label>' +
                '<label>Identifiant <input id="f-id" size="8" value="' + esc(eq.id) + '"' + (index === null ? '' : ' disabled') + ' placeholder="ex. P3"></label>' +
                '<label>Nom <input id="f-name" size="22" value="' + esc(eq.name) + '"></label></div><div class="period">' +
                Object.keys(type.params).map(function (k) {
                    var v = eq.params[k] !== undefined ? eq.params[k] : type.params[k];
                    if (k === 'reservoir') {
                        return '<label>Réservoir <select data-p="' + k + '"><option value="">(aucun)</option>' + tanks.map(function (r) {
                            return '<option value="' + esc(r.id) + '"' + (r.id === v ? ' selected' : '') + '>' + esc(r.id + ' — ' + r.name) + '</option>';
                        }).join('') + '</select></label>';
                    }
                    return '<label>' + esc(k) + ' <input data-p="' + k + '" size="6" value="' + esc(v) + '"></label>';
                }).join('') + '</div><div class="period"><button id="f-save" class="primary">Enregistrer</button><button id="f-cancel">Annuler</button></div></div>';
            document.getElementById('f-type').addEventListener('change', function (ev) { eq.type = ev.target.value; eq.params = {}; draw(); });
            document.getElementById('f-cancel').addEventListener('click', function () { form.innerHTML = ''; editing = null; });
            document.getElementById('f-save').addEventListener('click', function () {
                eq.id = document.getElementById('f-id').value.trim();
                eq.name = document.getElementById('f-name').value.trim();
                form.querySelectorAll('[data-p]').forEach(function (el) { eq.params[el.getAttribute('data-p')] = el.value; });
                var list = equipments.slice();
                if (index === null) { list.push(eq); } else { list[index] = eq; }
                saveEquipments(list, 'Équipement enregistré.');
            });
        }
        draw();
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    document.getElementById('e-new').addEventListener('click', function () { edit(null); });

    // ---------------------------------------------------------------- PostgreSQL
    var PG = ['host', 'port', 'database', 'user', 'password', 'table', 'interval'];
    function pgForm() {
        var c = { enabled: document.getElementById('pg-enabled').checked };
        PG.forEach(function (k) { c[k] = document.getElementById('pg-' + k).value.trim(); });
        return c;
    }
    function fillPg(c) {
        document.getElementById('pg-enabled').checked = !!c.enabled;
        PG.forEach(function (k) { document.getElementById('pg-' + k).value = k === 'password' ? '' : (c[k] === undefined ? '' : c[k]); });
    }
    document.getElementById('pg-test').addEventListener('click', function () {
        message('pg-status', 'Test...');
        call('POST', '/simulator/postgres/test', pgForm(), 'pg-status').then(function (r) {
            message('pg-status', 'Connexion réussie : table ' + r.data.table + ' (' + r.data.rows + ' lignes).');
        });
    });
    document.getElementById('pg-save').addEventListener('click', function () {
        call('PUT', '/simulator/postgres', pgForm(), 'pg-status').then(function (r) {
            fillPg(r.data);
            message('pg-status', 'Configuration enregistrée' + (r.data.enabled ? ' : enregistrement pendant la simulation.' : '.'));
            load();
        });
    });

    load().then(function (data) { fillPg(data.postgres); }).catch(function (err) { message('s-status', err.message, true); });
    setInterval(function () { if (!document.hidden && editing === null) { load().catch(function () { /* next time */ }); } }, 2000);
})();
