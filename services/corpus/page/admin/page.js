// The review page: one small script, no framework, no inline handlers, and every piece of text goes in through textContent. A word is shown
// only after a reveal; until then a row holds the category, the language and the counts, and a row of dots.
(function () {
  'use strict';
  var REASONS = ['not_a_term', 'known_innocent', 'duplicate', 'needs_context', 'other'];
  var TARGETS = ['ethnicity', 'religion', 'gender', 'sexuality', 'disability', 'nationality', 'other'];
  var TABS = [
    { id: 'queue', label: 'Queue', path: '/admin/api/queue?status=open', kind: 'submission' },
    { id: 'held', label: 'Held', path: '/admin/api/queue?status=held', kind: 'submission' },
    { id: 'disputed', label: 'Disputed terms', path: '/admin/api/terms?status=disputed', kind: 'term' },
    { id: 'provisional', label: 'Provisional terms', path: '/admin/api/terms?status=provisional', kind: 'term' },
    { id: 'accepted', label: 'Accepted terms', path: '/admin/api/terms?status=accepted', kind: 'term' },
    { id: 'withdrawn', label: 'Withdrawn terms', path: '/admin/api/terms?status=withdrawn', kind: 'term' },
    { id: 'reports', label: 'Reports', path: '/admin/api/reports?status=received', kind: 'report' }
  ];
  var current = TABS[0];
  var list = document.getElementById('list');
  var message = document.getElementById('message');
  var breakBox = document.getElementById('break');

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function say(text) {
    message.textContent = text || '';
  }

  function api(path, method, body) {
    var init = { method: method || 'GET', credentials: 'same-origin', headers: {} };
    if (init.method !== 'GET') {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body || {});
    }
    return fetch(path, init).then(function (res) {
      return res.json().then(function (json) {
        return { ok: res.ok, status: res.status, json: json };
      });
    });
  }

  function failure(res) {
    var code = res.json && res.json.error ? res.json.error : 'error ' + res.status;
    if (res.json && res.json.code) code += ' (' + res.json.code + ')';
    say('Not done: ' + code);
  }

  function select(options, label) {
    var s = el('select');
    s.setAttribute('aria-label', label);
    options.forEach(function (o) {
      var option = el('option', o);
      option.value = o;
      s.appendChild(option);
    });
    return s;
  }

  function button(text, onClick) {
    var b = el('button', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function metaText(item, kind) {
    if (kind === 'report') return [item.kind, item.termId, item.status, item.votes + ' of ' + item.needed + ' confirmations'].join(' - ');
    var parts = kind === 'term' ? [item.languages.join(', '), item.category, item.target, item.status] : [item.language, item.category, item.target, item.status];
    parts.push(item.approvals + ' approval' + (item.approvals === 1 ? '' : 's'));
    if (item.held) parts.push('held: ' + item.held);
    if (item.mine) parts.push('you: ' + item.mine);
    return parts.join(' - ');
  }

  function row(item, kind) {
    var li = el('li');
    li.setAttribute('data-id', item.id);
    li.appendChild(el('div', metaText(item, kind), 'meta'));
    var word = el('div', '\u2022\u2022\u2022\u2022\u2022\u2022', 'word masked');
    li.appendChild(word);
    var detail = el('div');
    li.appendChild(detail);
    var actions = el('div', null, 'actions');
    li.appendChild(actions);
    var reveal = button('Reveal', function () {
      var revealPath = kind === 'report' ? '/admin/api/terms/' + encodeURIComponent(item.termId) + '/reveal' : '/admin/api/' + kind + 's/' + encodeURIComponent(item.id) + '/reveal';
      api(revealPath, 'POST').then(function (res) {
        if (!res.ok) return failure(res);
        word.textContent = res.json.term;
        word.className = 'word';
        reveal.hidden = true;
        showDetail(detail, actions, item, kind, res.json);
        if (res.json.breakReminder) breakBox.hidden = false;
      });
    });
    actions.appendChild(reveal);
    return li;
  }

  function showDetail(detail, actions, item, kind, info) {
    detail.textContent = '';
    if (kind === 'submission') {
      if (info.note) detail.appendChild(el('p', 'Note: ' + info.note));
      if (info.knownInnocent) detail.appendChild(el('p', 'This is among the most common ordinary words of its language.'));
      if (info.collidesWith.length) detail.appendChild(el('p', 'Also an ordinary word in: ' + info.collidesWith.join(', ')));
      if (info.dictionary.length) detail.appendChild(el('p', 'Dictionary words that equal or contain it: ' + info.dictionary.join(', ')));
      var target = item.category === 'slur' && item.target === 'none' ? select(TARGETS, 'Target') : null;
      var override = el('input');
      override.type = 'checkbox';
      override.id = 'override-' + item.id;
      var overrideLabel = el('label', ' Override: the word is ordinary');
      overrideLabel.setAttribute('for', override.id);
      var reason = select(REASONS, 'Reason to decline');
      if (target) actions.appendChild(target);
      actions.appendChild(button('Approve', function () {
        var body = {};
        if (target) body.target = target.value;
        if (override.checked) body.overrideInnocent = true;
        act('/admin/api/submissions/' + encodeURIComponent(item.id) + '/approve', body, 'Approved');
      }));
      actions.appendChild(reason);
      actions.appendChild(button('Decline', function () {
        act('/admin/api/submissions/' + encodeURIComponent(item.id) + '/decline', { reason: reason.value }, 'Declined');
      }));
      if (item.held || info.knownInnocent) {
        actions.appendChild(override);
        actions.appendChild(overrideLabel);
      }
    } else if (kind === 'report') {
      detail.appendChild(el('p', 'The term is ' + info.status + ' (' + info.category + ', ' + info.target + ').'));
      actions.appendChild(button('Confirm', function () {
        act('/admin/api/reports/' + encodeURIComponent(item.id) + '/confirm', {}, 'Confirmed');
      }));
      actions.appendChild(button('Decline', function () {
        act('/admin/api/reports/' + encodeURIComponent(item.id) + '/decline', {}, 'Declined');
      }));
    } else {
      if (info.negatives.length) detail.appendChild(el('p', 'Lines that must never be blocked: ' + info.negatives.join(' | ')));
      if (info.collidesWith.length) detail.appendChild(el('p', 'Also an ordinary word in: ' + info.collidesWith.join(', ')));
      var line = el('input');
      line.type = 'text';
      line.maxLength = 200;
      line.setAttribute('aria-label', 'A line that must never be blocked');
      actions.appendChild(line);
      actions.appendChild(button('Add line', function () {
        act('/admin/api/terms/' + encodeURIComponent(item.id) + '/negative', { line: line.value }, 'Line added', true);
      }));
      var verb = info.status === 'disputed' || info.status === 'withdrawn' ? 'restore' : 'dispute';
      actions.appendChild(button(verb === 'restore' ? 'Restore' : 'Dispute', function () {
        act('/admin/api/terms/' + encodeURIComponent(item.id) + '/' + verb, {}, verb === 'restore' ? 'Restore vote recorded' : 'Disputed');
      }));
    }
  }

  function act(path, body, done, stay) {
    api(path, 'POST', body).then(function (res) {
      if (!res.ok) return failure(res);
      say(done);
      if (!stay) load();
    });
  }

  function load() {
    list.textContent = '';
    api(current.path).then(function (res) {
      if (!res.ok) return failure(res);
      if (!res.json.items.length) say('Nothing here.');
      else say('');
      res.json.items.forEach(function (item) {
        list.appendChild(row(item, current.kind));
      });
    });
  }

  function tabs() {
    var nav = document.getElementById('tabs');
    TABS.forEach(function (tab) {
      var b = button(tab.label, function () {
        current = tab;
        Array.prototype.forEach.call(nav.children, function (c) {
          c.setAttribute('aria-pressed', String(c === b));
        });
        load();
      });
      b.setAttribute('aria-pressed', String(tab === current));
      nav.appendChild(b);
    });
  }

  document.getElementById('break-ok').addEventListener('click', function () {
    breakBox.hidden = true;
  });
  api('/admin/api/me').then(function (res) {
    if (!res.ok) return failure(res);
    document.getElementById('who').textContent = 'Signed in as ' + res.json.email + (res.json.fluent.length ? ' (fluent: ' + res.json.fluent.join(', ') + ')' : '');
    tabs();
    load();
  });
})();
