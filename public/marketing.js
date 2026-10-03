'use strict';
// A signed-out refresh of an app screen (/#/residence/...) lands here: send it to sign-in, which returns to that screen.
if (/^#\/./.test(location.hash)) location.replace('/login' + location.hash);
const chapter = document.getElementById('chapter');
const player = document.getElementById('tutorial-player');
chapter.addEventListener('change', () => {
  if (chapter.value === '') return;
  const seek = () => {
    player.currentTime = Number(chapter.value);
    player.play().catch(() => {});
  };
  if (player.readyState >= 1) seek();
  else {
    player.addEventListener('loadedmetadata', seek, {once: true});
    player.load();
  }
});
