'use strict';
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
