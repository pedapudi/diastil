/* dia runtime v1 — embedded in every saved deck.
 * Present-mode navigation + build steps + slide transitions.
 * No dependencies, no network.
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

  /* present-only styles: transitions + step reveals. Injected at runtime,
   * never part of the saved document content. Motion respects
   * prefers-reduced-motion; the scale from fit() rides along via --dia-fit
   * so entrance transforms compose with it instead of clobbering it. */
  var style = document.createElement('style');
  style.id = 'dia-runtime-style';
  style.textContent =
    '@media (prefers-reduced-motion: no-preference) {' +
    'section.dia-slide[data-dia-anim="fade"] { animation: diaFade .3s ease both; }' +
    'section.dia-slide[data-dia-anim="slide"] { animation: diaSlide .36s cubic-bezier(.2,.7,.2,1) both; }' +
    'section.dia-slide[data-dia-anim="rise"] { animation: diaRise .36s cubic-bezier(.2,.7,.2,1) both; }' +
    '[data-dia-step] { transition: opacity .28s ease, translate .28s ease; }' +
    '}' +
    '@keyframes diaFade { from { opacity: 0; } }' +
    '@keyframes diaSlide { from { opacity: 0; transform: var(--dia-fit, none) translateX(3%); } to { transform: var(--dia-fit, none); } }' +
    '@keyframes diaRise { from { opacity: 0; transform: var(--dia-fit, none) translateY(2.5%); } to { transform: var(--dia-fit, none); } }';
  document.head.appendChild(style);

  function fromHash() {
    var m = /^#(\d+)$/.exec(location.hash);
    if (m) current = Math.min(slides.length - 1, Math.max(0, +m[1] - 1));
  }

  function steps(slide) {
    return Array.prototype.slice.call(slide.querySelectorAll('[data-dia-step]'))
      .sort(function (a, b) { return (+a.getAttribute('data-dia-step')) - (+b.getAttribute('data-dia-step')); });
  }

  function transitionOf(slide) {
    var t = slide.getAttribute('data-dia-transition') ||
      document.documentElement.getAttribute('data-dia-transition') || 'none';
    return t === 'fade' || t === 'slide' || t === 'rise' ? t : 'none';
  }

  function show(i, animate) {
    current = Math.min(slides.length - 1, Math.max(0, i));
    slides.forEach(function (s, j) {
      s.style.display = j === current ? '' : 'none';
      s.removeAttribute('data-dia-anim');
    });
    var t = transitionOf(slides[current]);
    if (animate && t !== 'none') {
      // restart the entrance animation even on repeated visits
      void slides[current].offsetWidth;
      slides[current].setAttribute('data-dia-anim', t);
    }
    steps(slides[current]).forEach(function (el) {
      el.style.opacity = '0';
      el.style.translate = '0 6px';
      el.removeAttribute('data-dia-step-shown');
    });
    if (location.hash !== '#' + (current + 1)) history.replaceState(null, '', '#' + (current + 1));
  }

  function advance(dir) {
    var pend = steps(slides[current]).filter(function (el) { return !el.hasAttribute('data-dia-step-shown'); });
    if (dir > 0 && pend.length) {
      pend[0].style.opacity = '';
      pend[0].style.translate = '';
      pend[0].setAttribute('data-dia-step-shown', '1');
      return;
    }
    show(current + dir, true);
  }

  function fit() {
    var s = slides[current];
    if (!s) return;
    var scale = Math.min(innerWidth / s.offsetWidth, innerHeight / s.offsetHeight);
    slides.forEach(function (sl) {
      sl.style.transformOrigin = 'top left';
      sl.style.setProperty('--dia-fit', 'scale(' + scale + ')');
      sl.style.transform = 'var(--dia-fit)';
    });
    document.body.style.overflow = 'hidden';
    document.body.style.margin = '0';
  }

  addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { advance(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { advance(-1); e.preventDefault(); }
    else if (e.key === 'Home') show(0, true);
    else if (e.key === 'End') show(slides.length - 1, true);
  });
  addEventListener('hashchange', function () { fromHash(); show(current, true); });
  addEventListener('resize', fit);

  fromHash();
  show(current, false);
  fit();
})();
