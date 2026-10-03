'use strict';
// FAQ search: filters questions and answers as you type. Lives in its own file so the site's CSP (script-src 'self') allows it.
(() => {
  const input = document.getElementById('faqSearch');
  const list = document.getElementById('faqList');
  const empty = document.getElementById('faqEmpty');
  if (!input || !list) return;
  const items = [...list.querySelectorAll('h2')].map(question => ({question, answer: question.nextElementSibling}));
  const filter = () => {
    const term = input.value.trim().toLowerCase();
    let shown = 0;
    for (const {question, answer} of items) {
      const text = (question.textContent + ' ' + (answer ? answer.textContent : '')).toLowerCase();
      const show = !term || text.includes(term);
      question.hidden = !show;
      if (answer) answer.hidden = !show;
      if (show) shown += 1;
    }
    if (empty) empty.hidden = shown > 0;
  };
  input.addEventListener('input', filter);
  if (input.value) filter();
})();
