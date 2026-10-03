'use strict';
// Compact phone homepage (see the end of home-refresh.css): tap-to-expand for the dense homepage blocks.
// At 760px and below it wraps headings in disclosure buttons and adds "details" buttons (aria-expanded/aria-controls);
// on wider screens it restores the original markup, so tablet and desktop are unchanged. No-JS visitors see everything.
(() => {
  const phone = matchMedia('(max-width: 760px)');
  const undo = [];
  let count = 0;
  const idOf = el => el.id || (el.id = 'mh-' + (++count));
  const button = (cls, controls) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = cls;
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', controls.map(idOf).join(' '));
    return btn;
  };
  // Accordion: the item's heading becomes the button; its paragraphs open and close.
  function accordion(itemSelector) {
    for (const item of document.querySelectorAll(itemSelector)) {
      if (getComputedStyle(item).display === 'none') continue;
      const head = item.querySelector('h3');
      const bodies = [...item.querySelectorAll(':scope > p')];
      if (!head || !bodies.length) continue;
      const btn = button('m-acc', bodies);
      btn.append(...head.childNodes); head.append(btn);
      item.classList.add('m-collapsed');
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(open));
        item.classList.toggle('m-collapsed', !open);
      });
      undo.push(() => { head.append(...btn.childNodes); btn.remove(); item.classList.remove('m-collapsed'); });
    }
  }
  // "More" button: shows extra lists or fine print below a short summary.
  function more(containerSelector, bodySelector, label) {
    for (const container of document.querySelectorAll(containerSelector)) {
      const bodies = [...container.querySelectorAll(bodySelector)];
      if (!bodies.length) continue;
      const btn = button('m-more', bodies);
      btn.textContent = label;
      bodies[0].before(btn);
      bodies.forEach(body => body.classList.add('m-hidden'));
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(open));
        bodies.forEach(body => body.classList.toggle('m-hidden', !open));
      });
      undo.push(() => { btn.remove(); bodies.forEach(body => body.classList.remove('m-hidden')); });
    }
  }
  function apply() {
    while (undo.length) undo.pop()();
    if (!phone.matches) return;
    more('.new-body', '.mini-checks', 'What’s included');
    more('.storm-steps > li', '.facts', 'Details');
    accordion('.feature-grid article');
    accordion('.trust-item');
    accordion('.faq-item');
    more('#pricing', ':scope > p.signup-small', 'Add-ons, limits and billing');
  }
  apply();
  phone.addEventListener('change', apply);
})();
