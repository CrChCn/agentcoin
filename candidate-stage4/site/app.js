/* Candidate shared app module (stage4): one file on all three shell pages.
 * Page modules preserved as DOM sections; behavior branches by element presence.
 * No keys, no auto-sign, read-only. */
(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    var roomForm = document.getElementById('rIdForm');
    if (roomForm) {
      roomForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var a = document.getElementById('rAddr');
        var out = document.getElementById('rIdOut');
        var v = a ? String(a.value || '').trim() : '';
        if (out) out.textContent = v ? 'адрес принят для чтения: ' + v.slice(0, 12) + '…' : 'введите AGT-адрес';
      });
    }
    var balForm = document.getElementById('bForm');
    if (balForm) {
      balForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var a = document.getElementById('bAddr');
        var out = document.getElementById('bOut');
        var v = a ? String(a.value || '').trim() : '';
        if (out) out.textContent = v ? 'баланс запрашивается чтением для: ' + v.slice(0, 12) + '… (подпись не требуется)' : 'введите AGT-адрес';
      });
    }
  });
})();
