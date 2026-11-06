// Einladungsseite: eingefügten Link öffnen (wichtig für die App auf dem Home-Bildschirm, die Links nicht direkt öffnen kann)
(function () {
  var next = (document.querySelector('#login input[name=next]') || {}).value || '/';
  var hash = location.hash || '';
  var login = document.getElementById('login');
  if (login && hash) login.querySelector('input[name=next]').value = next + hash;
  document.getElementById('invite').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = document.getElementById('link').value.trim();
    var m = v.match(/einladung\/([A-Za-z0-9_.-]+)/);
    if (!m) { document.getElementById('msg').textContent = 'Das ist kein gültiger Einladungslink.'; return; }
    var h = v.indexOf('#') > -1 ? v.slice(v.indexOf('#')) : hash;
    location.href = '/einladung/' + m[1] + '?next=' + encodeURIComponent(next) + h;
  });
  var p = new URLSearchParams(location.search);
  if (p.get('fehler')) document.getElementById('msg').textContent = p.get('fehler');
})();
