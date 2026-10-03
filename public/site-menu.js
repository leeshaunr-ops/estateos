'use strict';
// Phone header menu on the marketing pages: the ☰ button (shown at 760px and below, see marketing.css)
// opens the #site-menu dropdown. It closes on a link tap, Escape, a tap or focus outside the header,
// or when the window grows past the phone layout. A disclosure button: aria-expanded on the toggle, hidden on the panel.
(() => {
  const toggle = document.querySelector('.site-header .menu-toggle');
  const panel = toggle && document.getElementById(toggle.getAttribute('aria-controls'));
  if (!panel) return;
  const header = toggle.closest('.site-header');
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const setOpen = open => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    panel.hidden = !open;
    header.classList.toggle('menu-open', open);
  };
  toggle.addEventListener('click', () => setOpen(!isOpen()));
  panel.addEventListener('click', event => { if (event.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !isOpen()) return;
    const focusWasInside = header.contains(document.activeElement);
    setOpen(false);
    if (focusWasInside) toggle.focus();
  });
  // pointerdown rather than click: iOS Safari does not send clicks from plain page content to the document.
  document.addEventListener('pointerdown', event => { if (isOpen() && !header.contains(event.target)) setOpen(false); });
  header.addEventListener('focusout', event => { if (isOpen() && event.relatedTarget && !header.contains(event.relatedTarget)) setOpen(false); });
  matchMedia('(min-width: 761px)').addEventListener('change', event => { if (event.matches && isOpen()) setOpen(false); });
})();
