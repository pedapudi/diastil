/* dia runtime v1 — embedded in every saved deck.
 * Present-mode navigation + build steps. No dependencies, no network.
 * In the editor this script is inert (the editor strips/reinjects on save). */
(function () {
  'use strict';
  if (window.__diaRuntime) return;
  window.__diaRuntime = 1;

  var slides = Array.prototype.slice.call(
    document.querySelectorAll('section.dia-slide')
  );
  if (!slides.length) return;

  var current = 0;

  function fromHash() {
    var m = /^#(\d+)$/.exec(location.hash);
    if (m) current = Math.min(slides.length - 1, Math.max(0, +m[1] - 1));
  }

  function steps(slide) {
    return Array.prototype.slice.call(slide.querySelectorAll('[data-dia-step]'))
      .sort(function (a, b) { return (+a.getAttribute('data-dia-step')) - (+b.getAttribute('data-dia-step')); });
  }

  function show(i) {
    current = Math.min(slides.length - 1, Math.max(0, i));
    slides.forEach(function (s, j) { s.style.display = j === current ? '' : 'none'; });
    steps(slides[current]).forEach(function (el) { el.style.visibility = 'hidden'; el.removeAttribute('data-dia-step-shown'); });
    if (location.hash !== '#' + (current + 1)) history.replaceState(null, '', '#' + (current + 1));
  }

  function advance(dir) {
    var pend = steps(slides[current]).filter(function (el) { return !el.hasAttribute('data-dia-step-shown'); });
    if (dir > 0 && pend.length) {
      pend[0].style.visibility = '';
      pend[0].setAttribute('data-dia-step-shown', '1');
      return;
    }
    show(current + dir);
  }

  function fit() {
    var s = slides[current];
    if (!s) return;
    var scale = Math.min(innerWidth / s.offsetWidth, innerHeight / s.offsetHeight);
    slides.forEach(function (sl) {
      sl.style.transformOrigin = 'top left';
      sl.style.transform = 'scale(' + scale + ')';
    });
    document.body.style.overflow = 'hidden';
    document.body.style.margin = '0';
  }

  addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { advance(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { advance(-1); e.preventDefault(); }
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(slides.length - 1);
  });
  addEventListener('hashchange', function () { fromHash(); show(current); });
  addEventListener('resize', fit);

  fromHash();
  show(current);
  fit();
})();
